import * as v from "valibot";
import { configSchema } from "../src/config.js";
import { Auth, type Grant } from "../src/auth.js";
import { hash } from "../src/crypto.js";
import { DiscordService, type DiscordPort, type Message, type SendInput } from "../src/discord.js";
import { PublicError } from "../src/errors.js";
import { EventService, subscribeParams } from "../src/events.js";
import { Policy, snowflakeBefore } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { WebhookPost } from "../src/webhook.js";

export const guildId = "100000000000000001";
export const channelId = "100000000000000002";
export const humanId = "100000000000000003";
export const botId = "100000000000000004";
export const secret = `whsec_${Buffer.alloc(32, 13).toString("base64")}`;
export const access = "a".repeat(43);
export const secrets = {
  botToken: "b".repeat(40),
  clientSecret: "c".repeat(40),
  ownerPassword: "p".repeat(40),
};
export const startTime = Date.parse("2026-10-05T01:00:00.000Z");
export const idAt = (time: number) => (BigInt(snowflakeBefore(time)) + 1n).toString();

export const config = () =>
  v.parse(configSchema, {
    publicUrl: "https://bridge.example.org",
    oauth: {
      clientId: "dots",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    },
    callbackHosts: ["callback.example.org"],
    channels: [
      {
        id: channelId,
        guildId,
        since: "2026-10-01T00:00:00.000Z",
        historyHours: 24,
        write: true,
        events: "all",
      },
    ],
  });

export function message(time = startTime - 1000, overrides: Partial<Message> = {}): Message {
  return {
    id: idAt(time),
    channel_id: channelId,
    guild_id: guildId,
    author: { id: humanId, username: "test-user", bot: false },
    content: "hello",
    timestamp: new Date(time).toISOString(),
    edited_timestamp: null,
    mentions: [botId],
    attachments: [],
    reply_to_id: null,
    webhook: false,
    url: `https://discord.com/channels/${guildId}/${channelId}/${idAt(time)}`,
    ...overrides,
  };
}

export class FakeDiscord implements DiscordPort {
  readonly botId = botId;
  rows = new Map<string, Message>();
  sent: { input: SendInput; nonce: string }[] = [];
  reads: string[] = [];
  channelGuild = guildId;
  unavailable = false;
  failSend = false;
  async channel(id: string) {
    if (this.unavailable) throw new PublicError("Discord channel or message is unavailable");
    return { id, guildId: this.channelGuild, type: 0, name: "test-channel" };
  }
  async messages(channel: string, before: string, limit: number) {
    this.reads.push(channel);
    return [...this.rows.values()]
      .filter((m) => m.channel_id === channel && BigInt(m.id) < BigInt(before))
      .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
      .slice(0, limit);
  }
  async message(_channel: string, id: string) {
    this.reads.push(id);
    const m = this.rows.get(id);
    if (!m || this.unavailable) throw new PublicError("Discord channel or message is unavailable");
    return m;
  }
  async send(input: SendInput, nonce: string) {
    this.sent.push({ input, nonce });
    if (this.failSend) throw new Error("Request timeout (secret detail must not escape)");
    return message(startTime, {
      content: input.content,
      author: { id: botId, username: "test-bot", bot: true },
    });
  }
}

export function fixture(path = ":memory:", post?: WebhookPost) {
  let now = startTime;
  const c = config();
  const store = new Store(path, () => now);
  const auth = new Auth(c, secrets, store);
  const grant: Grant = {
    id: "test-grant",
    principal: auth.principal,
    clientId: c.oauth.clientId,
    expires: now + 30 * 86_400_000,
  };
  store.set("grant", grant.id, grant, grant.expires);
  store.set("access", hash(access), { grant: grant.id }, grant.expires);
  const port = new FakeDiscord();
  const discord = new DiscordService(port, new Policy(c.channels, () => now), store);
  const deliveries: { url: string; body: string; headers: Record<string, string> }[] = [];
  const defaultPost: WebhookPost = async (url, body, headers) => {
    deliveries.push({ url, body, headers });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    return {
      status: 200,
      body: parsed.type === "verification" ? JSON.stringify({ challenge: parsed.challenge }) : "{}",
      retryAfter: undefined,
    };
  };
  const events = new EventService(store, discord, auth, post ?? defaultPost, c.callbackHosts);
  const params = v.parse(subscribeParams, {
    name: "message.created",
    arguments: { channel_id: channelId },
    delivery: { mode: "webhook", url: "https://callback.example.org/event", secret },
  });
  return {
    config: c,
    store,
    auth,
    grant,
    port,
    discord,
    events,
    params,
    deliveries,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
