import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { subscribeParams, subscriptionId, type Subscription } from "../src/events.js";
import * as v from "valibot";
import { botId, channelId, fixture, message, secret, startTime } from "./fixtures.js";

test("subscription is deterministic, verified once, durable, renewable and owner-bound", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dots-discord-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite3");
  const f = fixture(path);
  await f.events.subscribe(f.grant, f.params);
  const id = subscriptionId(f.grant.principal, f.params);
  assert.notEqual(id, subscriptionId("other-owner", f.params));
  assert.equal(f.deliveries.length, 1);
  await f.events.subscribe(f.grant, f.params);
  assert.equal(f.deliveries.length, 1);
  const m = message();
  f.port.rows.set(m.id, m);
  f.events.enqueue(m);
  f.events.enqueue(m);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count, 1);
  f.store.close();
  const reopened = fixture(path);
  t.after(() => reopened.store.close());
  reopened.port.rows.set(m.id, m);
  assert.ok(reopened.store.get("subscription", id));
  await reopened.events.tick();
  assert.equal(reopened.deliveries.length, 1);
  assert.equal(JSON.parse(reopened.deliveries[0]!.body).eventId, `discord_${m.id}`);
  assert.equal(
    reopened.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count,
    0,
  );
});

test("callback challenge failure does not activate delivery", async (t) => {
  const f = fixture(":memory:", async () => ({
    status: 200,
    body: '{"challenge":"wrong"}',
    retryAfter: undefined,
  }));
  t.after(() => f.store.close());
  await assert.rejects(f.events.subscribe(f.grant, f.params), /rejected/);
  assert.equal(f.store.list("subscription").length, 0);
});

test("blocked callback and disallowed filter fail before verification", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await assert.rejects(
    f.events.subscribe(f.grant, {
      ...f.params,
      delivery: { ...f.params.delivery, url: "https://evil.example.org/" },
    }),
  );
  f.config.channels[0]!.events = "mentions";
  await assert.rejects(
    f.events.subscribe(f.grant, {
      ...f.params,
      arguments: { channel_id: channelId, mentions_only: false },
    }),
    /not allowed/,
  );
  assert.equal(f.deliveries.length, 0);
  assert.throws(() => v.parse(subscribeParams, { ...f.params, cursor: "replay" }));
  assert.throws(() => v.parse(subscribeParams, { ...f.params, ttlMs: -1 }));
});

test("human mentions only by default; bot/webhook/self never loop", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.events.subscribe(f.grant, f.params);
  for (const m of [
    message(startTime - 1, { mentions: [] }),
    message(startTime - 2, { author: { id: botId, username: "self", bot: false } }),
    message(startTime - 3, {
      author: { id: "100000000000000099", username: "another bot", bot: true },
    }),
    message(startTime - 4, { webhook: true }),
  ])
    f.events.enqueue(m);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count, 0);
  const m = message();
  f.port.rows.set(m.id, m);
  f.events.enqueue(m);
  await f.events.tick();
  assert.equal(f.deliveries.length, 2);
});

test("webhook retry keeps event ID/body, renews signature timestamp, respects Retry-After", async (t) => {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  let attempts = 0;
  const f = fixture(":memory:", async (_url, body, headers) => {
    const data = JSON.parse(body) as { type?: string; challenge?: string };
    if (data.type === "verification")
      return {
        status: 200,
        body: JSON.stringify({ challenge: data.challenge }),
        retryAfter: undefined,
      };
    calls.push({ body, headers });
    return { status: ++attempts === 1 ? 429 : 200, body: "{}", retryAfter: "20" };
  });
  t.after(() => f.store.close());
  await f.events.subscribe(f.grant, f.params);
  const m = message();
  f.port.rows.set(m.id, m);
  f.events.enqueue(m);
  await f.events.tick();
  assert.equal(calls.length, 1);
  f.advance(10_000);
  await f.events.tick();
  assert.equal(calls.length, 1);
  f.advance(11_000);
  await f.events.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.headers["webhook-id"], calls[1]!.headers["webhook-id"]);
  assert.notEqual(calls[0]!.headers["webhook-timestamp"], calls[1]!.headers["webhook-timestamp"]);
});

test("key rotation re-verifies and briefly dual signs", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.events.subscribe(f.grant, f.params);
  const nextSecret = `whsec_${Buffer.alloc(32, 25).toString("base64")}`;
  await f.events.subscribe(f.grant, {
    ...f.params,
    delivery: { ...f.params.delivery, secret: nextSecret },
  });
  assert.equal(f.deliveries.length, 2);
  const m = message();
  f.port.rows.set(m.id, m);
  f.events.enqueue(m);
  await f.events.tick();
  const delivery = f.deliveries.at(-1)!;
  for (const key of [secret, nextSecret]) {
    assert.equal(
      new Webhook(key).sign(`discord_${m.id}`, new Date(f.now()), delivery.body).split(",")[1] &&
        delivery.headers["webhook-signature"]!.includes(
          new Webhook(key).sign(`discord_${m.id}`, new Date(f.now()), delivery.body),
        ),
      true,
    );
  }
});

test("unsubscribe is idempotent, owner-scoped and purges queued payloads", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.events.subscribe(f.grant, f.params);
  f.events.enqueue(message());
  await f.events.unsubscribe({ ...f.grant, principal: "another-owner" }, f.params);
  assert.equal(f.store.list("subscription").length, 1);
  await f.events.unsubscribe(f.grant, f.params);
  await f.events.unsubscribe(f.grant, f.params);
  assert.equal(f.store.list("subscription").length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count, 0);
});

for (const change of ["revoke", "policy", "delete", "edit", "permission"] as const) {
  test(`queued events are not delivered after ${change}`, async (t) => {
    const f = fixture();
    t.after(() => f.store.close());
    await f.events.subscribe(f.grant, f.params);
    const m = message();
    f.port.rows.set(m.id, m);
    f.events.enqueue(m);
    if (change === "revoke") f.store.delete("grant", f.grant.id);
    if (change === "policy") f.config.channels[0]!.events = "off";
    if (change === "delete") f.port.rows.delete(m.id);
    if (change === "edit") m.content = "edited";
    if (change === "permission") f.port.unavailable = true;
    await f.events.tick();
    assert.equal(f.deliveries.length, 1); // Verification only.
    assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count, 0);
  });
}

test("finite TTL expires the subscription and unrenewed queue", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.events.subscribe(f.grant, { ...f.params, ttlMs: 1000 });
  const sub = f.store.list<Subscription>("subscription")[0]!.value;
  assert.equal(sub.expires - f.now(), 60_000); // Documented minimum lease.
  f.events.enqueue(message());
  f.advance(61_000);
  await f.events.tick();
  assert.equal(f.store.list("subscription").length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM deliveries").get()?.count, 0);
});

for (const status of [410, 413])
  test(`HTTP ${status} is never retried`, async (t) => {
    let attempts = 0;
    const f = fixture(":memory:", async (_url, body) => {
      const data = JSON.parse(body) as { type?: string; challenge?: string };
      if (data.type === "verification")
        return {
          status: 200,
          body: JSON.stringify({ challenge: data.challenge }),
          retryAfter: undefined,
        };
      attempts++;
      return { status, body: "{}", retryAfter: undefined };
    });
    t.after(() => f.store.close());
    await f.events.subscribe(f.grant, f.params);
    const m = message();
    f.port.rows.set(m.id, m);
    f.events.enqueue(m);
    await f.events.tick();
    f.advance(10_000);
    await f.events.tick();
    assert.equal(attempts, 1);
  });
