import assert from "node:assert/strict";
import { test } from "node:test";
import * as v from "valibot";
import { configSchema } from "../src/config.js";
import { channelId, fixture, idAt, message, startTime, config } from "./fixtures.js";

test("strict configuration rejects duplicate channels and invalid time windows", () => {
  const c = config();
  assert.throws(() => v.parse(configSchema, { ...c, channels: [...c.channels, ...c.channels] }));
  assert.throws(() => v.parse(configSchema, { ...c, publicUrl: "http://bridge.example.org" }));
  assert.throws(() => v.parse(configSchema, { ...c, callbackHosts: ["*.example.org"] }));
  assert.throws(() =>
    v.parse(configSchema, {
      ...c,
      channels: [{ ...c.channels[0], until: "2020-01-01T00:00:00Z" }],
    }),
  );
});
test("unknown channels, threads and too-old IDs are denied before message I/O", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await assert.rejects(
    f.discord.getMessage("100000000000000099", idAt(startTime - 1000)),
    /not allowed/,
  );
  await assert.rejects(
    f.discord.getMessage(channelId, idAt(startTime - 2 * 86_400_000)),
    /history window/,
  );
  assert.deepEqual(f.port.reads, []);
});
test("history pages and single reads enforce guild, channel and rolling cutoff", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const recent = message();
  const old = message(startTime - 2 * 86_400_000);
  f.port.rows.set(recent.id, recent);
  f.port.rows.set(old.id, old);
  assert.deepEqual((await f.discord.readMessages(channelId, 50)).messages, [recent]);
  f.port.channelGuild = "100000000000000099";
  await assert.rejects(f.discord.getMessage(channelId, recent.id), /configured guild/);
  f.port.channelGuild = recent.guild_id;
  f.advance(2 * 86_400_000);
  await assert.rejects(f.discord.getMessage(channelId, recent.id), /history window/);
});
test("single-message response cannot smuggle content from another channel", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const m = message(undefined, { channel_id: "100000000000000099" });
  f.port.rows.set(m.id, m);
  await assert.rejects(f.discord.getMessage(channelId, m.id), /permitted scope/);
});
test("reply references use exactly the same history policy as reads", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await assert.rejects(
    f.discord.send(f.grant.principal, {
      channel_id: channelId,
      content: "hi",
      reply_to_id: idAt(startTime - 2 * 86_400_000),
      idempotency_key: "reply-key-001",
    }),
    /history window/,
  );
  assert.equal(f.port.sent.length, 0);
});
test("sends are idempotent and key reuse with different content is rejected", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const input = { channel_id: channelId, content: "hello", idempotency_key: "send-key-001" };
  const first = await f.discord.send(f.grant.principal, input);
  const second = await f.discord.send(f.grant.principal, input);
  assert.equal(first.id, second.id);
  assert.equal(second.reused, true);
  assert.equal(f.port.sent.length, 1);
  await assert.rejects(
    f.discord.send(f.grant.principal, { ...input, content: "different" }),
    /different message/,
  );
});
test("ambiguous send outcome is not automatically repeated", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.port.failSend = true;
  const input = { channel_id: channelId, content: "hello", idempotency_key: "send-key-001" };
  await assert.rejects(f.discord.send(f.grant.principal, input), /unconfirmed/);
  await assert.rejects(f.discord.send(f.grant.principal, input), /unknown/);
  assert.equal(f.port.sent.length, 1);
});
test("read-only and expired channels never send", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.config.channels[0]!.write = false;
  await assert.rejects(
    f.discord.send(f.grant.principal, {
      channel_id: channelId,
      content: "no",
      idempotency_key: "send-key-001",
    }),
    /not allowed/,
  );
  assert.equal(f.port.sent.length, 0);
});
