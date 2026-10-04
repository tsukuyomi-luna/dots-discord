import express, { type Request, type Response, type Router } from "express";
import type { Config, Secrets } from "./config.js";
import { hash, pkce, randomToken, sameSecret } from "./crypto.js";
import { Store } from "./store.js";

const SCOPE = "discord";
const ACCESS_MS = 15 * 60_000;
const GRANT_MS = 30 * 86_400_000;
export interface Grant {
  id: string;
  principal: string;
  clientId: string;
  expires: number;
}
interface Code {
  grant: string;
  redirect: string;
  challenge: string;
}
interface Token {
  grant: string;
  used?: boolean;
}
interface Consent {
  redirect: string;
  challenge: string;
  state: string;
  cookie: string;
}

class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
function field(source: unknown, key: string, required = true): string {
  const value =
    source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > 4096 || (required && !value))
    throw new AuthError("invalid_request");
  return value;
}
function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** One operator + one pre-registered confidential OAuth client. No open registration. */
export class Auth {
  readonly principal: string;
  readonly resource: string;
  private attempts = new Map<string, { count: number; until: number }>();

  constructor(
    readonly config: Config,
    readonly secrets: Secrets,
    readonly store: Store,
  ) {
    this.principal = hash(`${config.publicUrl}\n${config.oauth.clientId}`);
    this.resource = `${config.publicUrl}/mcp`;
  }
  private rate(key: string, max: number): void {
    const current = this.attempts.get(key);
    const slot =
      current && current.until > this.store.now()
        ? current
        : { count: 0, until: this.store.now() + 60_000 };
    this.attempts.set(key, slot);
    if (++slot.count > max) throw new AuthError("temporarily_unavailable", 429);
  }
  private client(req: Request): void {
    let clientId = field(req.body, "client_id", false);
    let secret = field(req.body, "client_secret", false);
    if (req.headers.authorization) {
      if (!req.headers.authorization.startsWith("Basic ") || secret)
        throw new AuthError("invalid_client", 401);
      const basic = Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8");
      const colon = basic.indexOf(":");
      if (colon < 0) throw new AuthError("invalid_client", 401);
      try {
        const id = decodeURIComponent(basic.slice(0, colon));
        if (clientId && clientId !== id) throw new AuthError("invalid_client", 401);
        clientId = id;
        secret = decodeURIComponent(basic.slice(colon + 1));
      } catch {
        throw new AuthError("invalid_client", 401);
      }
    }
    if (clientId !== this.config.oauth.clientId || !sameSecret(secret, this.secrets.clientSecret))
      throw new AuthError("invalid_client", 401);
  }
  grant(id: string): Grant | undefined {
    const grant = this.store.get<Grant>("grant", id);
    return grant?.principal === this.principal && grant.clientId === this.config.oauth.clientId
      ? grant
      : undefined;
  }
  authenticate(authorization: string | undefined): Grant | undefined {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 512) return;
    const token = this.store.get<Token>("access", hash(authorization.slice(7)));
    const grant = token ? this.grant(token.grant) : undefined;
    if (grant?.clientId !== this.config.oauth.clientId || grant.principal !== this.principal)
      return;
    return grant;
  }
  unauthorized(res: Response): void {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
    );
    res.status(401).json({ error: "invalid_token" });
  }
  private issue(grant: Grant): object {
    const access = randomToken();
    const refresh = randomToken();
    this.store.set(
      "access",
      hash(access),
      { grant: grant.id },
      Math.min(this.store.now() + ACCESS_MS, grant.expires),
    );
    this.store.set("refresh", hash(refresh), { grant: grant.id, used: false }, grant.expires);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.floor(Math.min(ACCESS_MS, grant.expires - this.store.now()) / 1000),
      scope: SCOPE,
    };
  }

  router(): Router {
    const router = express.Router();
    const route =
      (work: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
        res.set("Cache-Control", "no-store");
        try {
          work(req, res);
        } catch (error) {
          const known = error instanceof AuthError ? error : new AuthError("server_error", 500);
          if (known.status === 429) res.set("Retry-After", "60");
          res.status(known.status).json({ error: known.code });
        }
      };
    router.get(
      ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
      route((_, res) => {
        res.json({
          resource: this.resource,
          authorization_servers: [this.config.publicUrl],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ["header"],
          resource_name: "Discord bridge",
        });
      }),
    );
    router.get(
      "/.well-known/oauth-authorization-server",
      route((_, res) => {
        res.json({
          issuer: this.config.publicUrl,
          authorization_endpoint: `${this.config.publicUrl}/oauth/authorize`,
          token_endpoint: `${this.config.publicUrl}/oauth/token`,
          revocation_endpoint: `${this.config.publicUrl}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          scopes_supported: [SCOPE],
          authorization_response_iss_parameter_supported: true,
        });
      }),
    );
    router.get(
      "/oauth/authorize",
      route((req, res) => {
        this.rate("authorize", 30);
        if (field(req.query, "client_id") !== this.config.oauth.clientId)
          throw new AuthError("invalid_client");
        const redirect = field(req.query, "redirect_uri");
        if (!this.config.oauth.redirectUris.includes(redirect))
          throw new AuthError("invalid_request");
        if (field(req.query, "resource") !== this.resource) throw new AuthError("invalid_target");
        if (field(req.query, "response_type") !== "code")
          throw new AuthError("unsupported_response_type");
        const scope = field(req.query, "scope", false);
        if (scope && scope !== SCOPE) throw new AuthError("invalid_scope");
        const challenge = field(req.query, "code_challenge");
        if (
          field(req.query, "code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge)
        )
          throw new AuthError("invalid_request");
        const ticket = randomToken();
        const cookie = randomToken();
        this.store.set(
          "consent",
          hash(ticket),
          {
            redirect,
            challenge,
            state: field(req.query, "state"),
            cookie: hash(cookie),
          } satisfies Consent,
          this.store.now() + 5 * 60_000,
        );
        res.cookie("bridge_consent", cookie, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/oauth/approve",
          maxAge: 5 * 60_000,
        });
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        res
          .type("html")
          .send(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Discord</title><h1>Connect Discord</h1><p>Client ${html(this.config.oauth.clientId)}</p><ul>${this.config.channels.map((c) => `<li>${html(c.id)} · ${c.write ? "read + send" : "read only"} · ${c.historyHours} h history · since ${html(c.since)}</li>`).join("")}</ul><form method="post" action="/oauth/approve"><input type="hidden" name="ticket" value="${ticket}"><label>Operator password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Allow</button></form></html>`,
          );
      }),
    );
    router.use("/oauth", express.urlencoded({ extended: false, limit: "12kb" }));
    router.post(
      "/oauth/approve",
      route((req, res) => {
        this.rate("approve", 10);
        if (req.headers.origin !== this.config.publicUrl) throw new AuthError("access_denied", 403);
        const ticket = field(req.body, "ticket");
        const consent = this.store.get<Consent>("consent", hash(ticket));
        const cookie =
          req.headers.cookie
            ?.split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("bridge_consent="))
            ?.slice("bridge_consent=".length) ?? "";
        if (
          !consent ||
          !sameSecret(hash(cookie), consent.cookie) ||
          !sameSecret(field(req.body, "password"), this.secrets.ownerPassword)
        )
          throw new AuthError("access_denied", 403);
        const grant: Grant = {
          id: randomToken(),
          principal: this.principal,
          clientId: this.config.oauth.clientId,
          expires: this.store.now() + GRANT_MS,
        };
        const code = randomToken();
        this.store.transaction(() => {
          this.store.delete("consent", hash(ticket));
          this.store.set("grant", grant.id, grant, grant.expires);
          this.store.set(
            "code",
            hash(code),
            {
              grant: grant.id,
              redirect: consent.redirect,
              challenge: consent.challenge,
            } satisfies Code,
            this.store.now() + 60_000,
          );
        });
        const callback = new URL(consent.redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", consent.state);
        callback.searchParams.set("iss", this.config.publicUrl);
        res.clearCookie("bridge_consent", {
          path: "/oauth/approve",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        });
        res.redirect(303, callback.toString());
      }),
    );
    router.post(
      "/oauth/token",
      route((req, res) => {
        this.rate("token", 60);
        this.client(req);
        if (field(req.body, "resource") !== this.resource) throw new AuthError("invalid_target");
        const type = field(req.body, "grant_type");
        if (type === "authorization_code") {
          const key = hash(field(req.body, "code"));
          const code = this.store.get<Code>("code", key);
          const grant = code ? this.grant(code.grant) : undefined;
          const verifier = field(req.body, "code_verifier");
          if (
            !code ||
            !grant ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
            !sameSecret(pkce(verifier), code.challenge) ||
            field(req.body, "redirect_uri") !== code.redirect
          )
            throw new AuthError("invalid_grant");
          const tokens = this.store.transaction(() => {
            this.store.delete("code", key);
            return this.issue(grant);
          });
          res.json(tokens);
        } else if (type === "refresh_token") {
          const key = hash(field(req.body, "refresh_token"));
          const token = this.store.get<Token>("refresh", key);
          const grant = token ? this.grant(token.grant) : undefined;
          if (token?.used) {
            this.store.delete("grant", token.grant);
            throw new AuthError("invalid_grant");
          }
          if (!token || !grant) throw new AuthError("invalid_grant");
          const scope = field(req.body, "scope", false);
          if (scope && scope !== SCOPE) throw new AuthError("invalid_scope");
          res.json(
            this.store.transaction(() => {
              this.store.set("refresh", key, { ...token, used: true }, grant.expires);
              return this.issue(grant);
            }),
          );
        } else throw new AuthError("unsupported_grant_type");
      }),
    );
    router.post(
      "/oauth/revoke",
      route((req, res) => {
        this.rate("revoke", 60);
        this.client(req);
        const key = hash(field(req.body, "token"));
        const token = this.store.get<Token>("access", key) ?? this.store.get<Token>("refresh", key);
        if (token) this.store.delete("grant", token.grant);
        res.status(200).end();
      }),
    );
    return router;
  }
}
