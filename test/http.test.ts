import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/app.js";
import { pkce } from "../src/crypto.js";
import { access, channelId, fixture, message, secrets } from "./fixtures.js";

async function httpFixture(t: TestContext) {
  const f = fixture();
  const { app, close } = createApp(f.config, f.auth, f.discord, f.events);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await close();
    f.store.close();
  });
  // Node fetch deliberately overwrites Host; use raw HTTP to model a TLS
  // reverse proxy preserving the public host while dialing loopback.
  const request = (path: string, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers = new Headers({ host: "bridge.example.org", ...init.headers });
      const req = httpRequest(
        base + path,
        { method: init.method ?? "GET", headers: Object.fromEntries(headers) },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (data: Buffer) => chunks.push(data));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            resolve(
              new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
                status: res.statusCode,
                headers: responseHeaders,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(init.body?.toString());
    });
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    token = access,
    overrides: Record<string, string> = {},
  ) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
        ...overrides,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const json = (await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
    return { response, json };
  };
  const form = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(data),
    });
  return { ...f, request, rpc, form };
}

test("metadata, authentication, host and origin boundaries", async (t) => {
  const f = await httpFixture(t);
  const metadata = (await (
    await f.request("/.well-known/oauth-authorization-server")
  ).json()) as Record<string, unknown>;
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  const denied = await f.request("/mcp", { method: "POST" });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate")!, /resource_metadata=/);
  assert.equal(
    (await f.request("/healthz", { headers: { host: "evil.example.org" } })).status,
    403,
  );
  assert.equal(
    (await f.request("/healthz", { headers: { origin: "https://evil.example.org" } })).status,
    403,
  );
});

test("real SDK wire discovery advertises tools and events on modern protocol", async (t) => {
  const f = await httpFixture(t);
  const { response, json } = await f.rpc("server/discover");
  assert.equal(response.status, 200, JSON.stringify(json));
  assert.equal(json.result?.resultType, "complete");
  assert.deepEqual(json.result?.supportedVersions, ["2026-07-28"]);
  assert.deepEqual((json.result?.capabilities as Record<string, unknown>)?.events, {});
  const listed = await f.rpc("tools/list");
  assert.ok(
    (listed.json.result?.tools as { name: string }[]).some(
      (tool) => tool.name === "discord_send_message",
    ),
  );
  const events = await f.rpc("events/list");
  assert.equal(events.response.status, 200, JSON.stringify(events.json));
  assert.equal((events.json.result?.events as { name: string }[])[0]?.name, "message.created");
});

test("wire method/header mismatch is rejected and legacy is not silently accepted", async (t) => {
  const f = await httpFixture(t);
  const mismatched = await f.rpc("tools/list", {}, access, { "Mcp-Method": "tools/call" });
  assert.equal(mismatched.response.status, 400);
  const legacy = await f.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "old", version: "1" },
      },
    }),
  });
  assert.equal(legacy.status, 400);
});

test("HTTP MCP subscription -> injected Discord event -> signed callback -> reply tool", async (t) => {
  const f = await httpFixture(t);
  const subscribed = await f.rpc("events/subscribe", f.params);
  assert.equal(subscribed.response.status, 200, JSON.stringify(subscribed.json));
  assert.ok(subscribed.json.result?.id, JSON.stringify(subscribed.json));
  const m = message();
  f.port.rows.set(m.id, m);
  f.events.enqueue(m);
  await f.events.tick();
  assert.equal(f.deliveries.length, 2);
  const event = JSON.parse(f.deliveries[1]!.body) as { data: { id: string }; eventId: string };
  assert.equal(event.data.id, m.id);
  assert.equal(f.deliveries[1]!.headers["webhook-id"], event.eventId);
  const sent = await f.rpc("tools/call", {
    name: "discord_send_message",
    arguments: {
      channel_id: channelId,
      content: "reply from dots",
      reply_to_id: m.id,
      idempotency_key: "http-reply-001",
    },
  });
  assert.notEqual(sent.json.result?.isError, true, JSON.stringify(sent.json));
  assert.equal(f.port.sent.length, 1);
  assert.equal(f.port.sent[0]!.input.reply_to_id, m.id);
  await f.rpc("tools/call", {
    name: "discord_send_message",
    arguments: {
      channel_id: channelId,
      content: "reply from dots",
      reply_to_id: m.id,
      idempotency_key: "http-reply-001",
    },
  });
  assert.equal(f.port.sent.length, 1);
});

test("bad arguments and out-of-scope tools do not reach Discord", async (t) => {
  const f = await httpFixture(t);
  const read = await f.rpc("tools/call", {
    name: "discord_read_messages",
    arguments: { channel_id: "100000000000000099" },
  });
  assert.equal(read.json.result?.isError, true);
  const send = await f.rpc("tools/call", {
    name: "discord_send_message",
    arguments: {
      channel_id: channelId,
      content: "x".repeat(2001),
      idempotency_key: "oversize-001",
    },
  });
  assert.ok(send.json.result?.isError || send.json.error);
  assert.equal(f.port.sent.length, 0);
  assert.deepEqual(f.port.reads, []);
});

async function authorize(f: Awaited<ReturnType<typeof httpFixture>>) {
  const verifier = "v".repeat(64);
  const query = new URLSearchParams({
    client_id: "dots",
    redirect_uri: f.config.oauth.redirectUris[0]!,
    response_type: "code",
    resource: f.auth.resource,
    scope: "discord",
    state: "test-state",
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
  });
  const consent = await f.request("/oauth/authorize?" + query);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(ticket);
  const cookie = consent.headers.get("set-cookie")!.split(";")[0]!;
  const approved = await f.form(
    "/oauth/approve",
    { ticket, password: secrets.ownerPassword },
    { origin: f.config.publicUrl, cookie },
  );
  assert.equal(approved.status, 303, await approved.text());
  const redirect = new URL(approved.headers.get("location")!);
  assert.equal(redirect.searchParams.get("state"), "test-state");
  assert.equal(redirect.searchParams.get("iss"), f.config.publicUrl);
  return { verifier, code: redirect.searchParams.get("code")! };
}

test("full OAuth PKCE grant, audience binding, single-use code, refresh rotation and revocation", async (t) => {
  const f = await httpFixture(t);
  const { code, verifier } = await authorize(f);
  const tokenRequest = {
    client_id: "dots",
    client_secret: secrets.clientSecret,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: f.config.oauth.redirectUris[0]!,
    resource: f.auth.resource,
  };
  assert.equal(
    (await f.form("/oauth/token", { ...tokenRequest, resource: "https://wrong.example.org" }))
      .status,
    400,
  );
  assert.equal(
    (await f.form("/oauth/token", { ...tokenRequest, code_verifier: "wrong".repeat(16) })).status,
    400,
  );
  assert.equal(
    (await f.form("/oauth/token", { ...tokenRequest, client_secret: "wrong" })).status,
    401,
  );
  const response = await f.form("/oauth/token", tokenRequest);
  assert.equal(response.status, 200);
  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  assert.ok(f.auth.authenticate(`Bearer ${tokens.access_token}`));
  assert.equal((await f.form("/oauth/token", tokenRequest)).status, 400);
  const refresh = {
    client_id: "dots",
    client_secret: secrets.clientSecret,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    resource: f.auth.resource,
  };
  const renewed = await f.form("/oauth/token", refresh);
  assert.equal(renewed.status, 200);
  const newTokens = (await renewed.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(tokens.refresh_token, newTokens.refresh_token);
  assert.ok(f.auth.authenticate(`Bearer ${newTokens.access_token}`));
  assert.equal((await f.form("/oauth/token", refresh)).status, 400); // Reuse revokes the family.
  assert.equal(f.auth.authenticate(`Bearer ${newTokens.access_token}`), undefined);
});

test("OAuth rejects open redirects, plain PKCE, wrong resource and cross-origin approval", async (t) => {
  const f = await httpFixture(t);
  const base = {
    client_id: "dots",
    redirect_uri: f.config.oauth.redirectUris[0]!,
    response_type: "code",
    resource: f.auth.resource,
    state: "test",
    code_challenge: pkce("v".repeat(64)),
    code_challenge_method: "S256",
  };
  for (const patch of [
    { redirect_uri: "https://evil.example.org/" },
    { code_challenge_method: "plain" },
    { resource: "https://wrong.example.org" },
    { client_id: "attacker" },
  ]) {
    assert.equal(
      (await f.request("/oauth/authorize?" + new URLSearchParams({ ...base, ...patch }))).status,
      400,
    );
  }
  assert.equal(
    (
      await f.form(
        "/oauth/approve",
        { ticket: "x", password: secrets.ownerPassword },
        { origin: "https://chatgpt.com" },
      )
    ).status,
    403,
  );
});

test("disconnect revokes token family and pending subscriptions", async (t) => {
  const f = await httpFixture(t);
  await f.events.subscribe(f.grant, f.params);
  f.events.enqueue(message());
  const revoked = await f.form("/oauth/revoke", {
    client_id: "dots",
    client_secret: secrets.clientSecret,
    token: access,
  });
  assert.equal(revoked.status, 200);
  assert.equal(f.auth.authenticate(`Bearer ${access}`), undefined);
  await f.events.tick();
  assert.equal(f.store.list("subscription").length, 0);
});
