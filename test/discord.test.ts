import assert from "node:assert/strict";
import test from "node:test";
import { Routes, type APIMessage } from "discord.js";
import { LiveDiscord, normalizeMessage } from "../src/discord.js";
import { channelId, guildId, humanId, idAt, startTime } from "./fixtures.js";

function apiMessage(): APIMessage {
  return {
    id: idAt(startTime),
    channel_id: channelId,
    author: {
      id: humanId,
      username: "test-user",
      discriminator: "0",
      global_name: null,
      avatar: null,
    },
    content: "hello",
    timestamp: new Date(startTime).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
  };
}

test("Discord normalization never expands embeds, referenced messages or forwarded snapshots", () => {
  const raw = {
    ...apiMessage(),
    embeds: [{ description: "secret embed" }],
    referenced_message: { ...apiMessage(), content: "secret reply" },
    message_snapshots: [{ message: { ...apiMessage(), content: "secret forward" } }],
    message_reference: { channel_id: channelId, message_id: idAt(startTime - 1000) },
  };
  const result = normalizeMessage(raw, guildId);
  assert.equal(result.reply_to_id, raw.message_reference.message_id);
  assert.equal(result.content, "hello");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("live Discord REST adapter sends no pings, enforces nonce and does not fall back from replies", async (t) => {
  const live = new LiveDiscord();
  t.after(() => live.close());
  t.mock.method(live.client.rest, "get", async (route: string) => {
    assert.equal(route, Routes.channel(channelId));
    return { id: channelId, guild_id: guildId, type: 0, name: "test-channel" };
  });
  let posted: unknown;
  t.mock.method(live.client.rest, "post", async (route: string, options: { body: unknown }) => {
    assert.equal(route, Routes.channelMessages(channelId));
    posted = options.body;
    return apiMessage();
  });
  const input = {
    channel_id: channelId,
    content: "@everyone hello",
    reply_to_id: idAt(startTime - 1000),
    idempotency_key: "test-send-key",
  };
  await live.send(input, "test-nonce");
  assert.deepEqual(posted, {
    content: input.content,
    nonce: "test-nonce",
    enforce_nonce: true,
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: {
      message_id: input.reply_to_id,
      channel_id: channelId,
      fail_if_not_exists: true,
    },
  });
});
