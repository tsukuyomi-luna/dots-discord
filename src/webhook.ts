import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";
import { CallbackError } from "./errors.js";

export interface WebhookResponse {
  status: number;
  body: string;
  retryAfter: string | undefined;
}
export type WebhookPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<WebhookResponse>;

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    // Only current IPv6 global-unicast allocation; mapped IPv4, NAT64,
    // link-local, documentation, multicast and transition ranges are denied.
    return parsed.kind() === "ipv4" || /^[23]/.test(parsed.toNormalizedString());
  } catch {
    return false;
  }
}

export function callbackUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackError("invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !hosts.includes(url.hostname)
  )
    throw new CallbackError("destination_not_allowed");
  return url;
}

export function signingSecret(value: string): void {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new CallbackError("invalid_secret");
  const encoded = value.slice(6);
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length < 24 ||
    decoded.length > 64 ||
    decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    throw new CallbackError("invalid_secret");
}

export function signedHeaders(
  id: string,
  subscriptionId: string,
  body: string,
  secrets: string[],
  now: number,
): Record<string, string> {
  if (Buffer.byteLength(body) > 256 * 1024) throw new CallbackError("payload_too_large");
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(now / 1000)),
    "webhook-signature": secrets
      .map((secret) => new Webhook(secret).sign(id, new Date(now), body))
      .join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

/** DNS is resolved on EVERY attempt, and the actual TLS socket is pinned to
 * the checked IP. A second DNS lookup cannot bypass the public-address test. */
export function secureWebhookPost(hosts: readonly string[]): WebhookPost {
  return async (raw, body, headers) => {
    const url = callbackUrl(raw, hosts);
    const signal = AbortSignal.timeout(10_000);
    let addresses: Awaited<ReturnType<typeof lookup>>[];
    try {
      addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = () => reject(new CallbackError("timeout"));
        signal.addEventListener("abort", abort, { once: true });
        void lookup(url.hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } catch {
      throw new CallbackError(signal.aborted ? "timeout" : "dns_failed");
    }
    if (!addresses.length || !addresses.every((entry) => publicAddress(entry.address)))
      throw new CallbackError("non_public_address");
    const address = addresses[0]!;
    return new Promise<WebhookResponse>((resolve, reject) => {
      const req = request(
        {
          hostname: address.address,
          family: address.family,
          port: 443,
          servername: url.hostname,
          rejectUnauthorized: true,
          agent: false,
          method: "POST",
          path: url.pathname + url.search,
          signal,
          headers: { ...headers, Host: url.hostname, "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8192) {
              res.destroy();
              reject(new CallbackError("response_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => reject(new CallbackError("network_error")));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              retryAfter: res.headers["retry-after"],
            }),
          );
        },
      );
      req.on("error", () =>
        reject(new CallbackError(signal.aborted ? "timeout" : "network_error")),
      );
      req.end(body);
    });
  };
}
