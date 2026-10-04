import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Routes,
  type APIMessage,
  type RESTGetAPIChannelResult,
} from "discord.js";
import { hash } from "./crypto.js";
import { PublicError } from "./errors.js";
import { Policy, snowflakeBefore } from "./policy.js";
import { Store } from "./store.js";

export interface Message {
  id: string;
  channel_id: string;
  guild_id: string;
  author: { id: string; username: string; bot: boolean };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  mentions: string[];
  attachments: { id: string; filename: string; url: string; content_type: string | null }[];
  reply_to_id: string | null;
  webhook: boolean;
  url: string;
}
export interface Channel {
  id: string;
  guildId: string;
  name: string;
  type: number;
}
export interface SendInput {
  channel_id: string;
  content: string;
  reply_to_id?: string;
  idempotency_key: string;
}
export interface DiscordPort {
  readonly botId: string;
  channel(id: string): Promise<Channel>;
  messages(channelId: string, before: string, limit: number): Promise<Message[]>;
  message(channelId: string, messageId: string): Promise<Message>;
  send(input: SendInput, nonce: string): Promise<Message>;
}

export function normalizeMessage(message: APIMessage, guildId: string): Message {
  return {
    id: message.id,
    channel_id: message.channel_id,
    guild_id: guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot ?? false,
    },
    content: message.content,
    timestamp: message.timestamp,
    edited_timestamp: message.edited_timestamp,
    mentions: message.mentions.map((u) => u.id),
    attachments: message.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      content_type: a.content_type ?? null,
    })),
    reply_to_id: message.message_reference?.message_id ?? null,
    webhook: Boolean(message.webhook_id),
    url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  };
}

export class LiveDiscord implements DiscordPort {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  get botId(): string {
    return this.client.user?.id ?? "";
  }
  async start(
    token: string,
    onMessage: (message: Message) => void,
    onRemove: (id: string) => void,
  ): Promise<void> {
    // The payload is reduced before it reaches the durable queue. No embeds,
    // forwarded snapshots, or expanded reply messages cross the boundary.
    this.client.on(Events.MessageCreate, (m) => {
      if (!m.guildId) return;
      onMessage({
        id: m.id,
        channel_id: m.channelId,
        guild_id: m.guildId,
        author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        edited_timestamp: m.editedAt?.toISOString() ?? null,
        mentions: [...m.mentions.users.keys()],
        attachments: [...m.attachments.values()].map((a) => ({
          id: a.id,
          filename: a.name,
          url: a.url,
          content_type: a.contentType,
        })),
        reply_to_id: m.reference?.messageId ?? null,
        webhook: Boolean(m.webhookId),
        url: m.url,
      });
    });
    this.client.on(Events.MessageDelete, (m) => onRemove(m.id));
    this.client.on(Events.MessageBulkDelete, (messages) => {
      for (const id of messages.keys()) onRemove(id);
    });
    this.client.on(Events.MessageUpdate, (_, m) => onRemove(m.id));
    this.client.on(Events.Error, () => console.error("discord_gateway_error"));
    await this.client.login(token);
  }
  async channel(id: string): Promise<Channel> {
    try {
      const c = (await this.client.rest.get(Routes.channel(id))) as RESTGetAPIChannelResult;
      if (!("guild_id" in c) || !c.guild_id || ![0, 5, 10, 11, 12].includes(c.type))
        throw new PublicError(
          "Only explicitly allowed guild text channels or threads are supported",
        );
      return { id: c.id, guildId: c.guild_id, name: c.name ?? "", type: c.type };
    } catch (error) {
      throw discordError(error);
    }
  }
  async messages(channelId: string, before: string, limit: number): Promise<Message[]> {
    const c = await this.channel(channelId);
    try {
      const data = (await this.client.rest.get(Routes.channelMessages(channelId), {
        query: new URLSearchParams({ before, limit: String(limit) }),
      })) as APIMessage[];
      return data.map((m) => normalizeMessage(m, c.guildId));
    } catch (error) {
      throw discordError(error);
    }
  }
  async message(channelId: string, messageId: string): Promise<Message> {
    const c = await this.channel(channelId);
    try {
      const m = (await this.client.rest.get(
        Routes.channelMessage(channelId, messageId),
      )) as APIMessage;
      return normalizeMessage(m, c.guildId);
    } catch (error) {
      throw discordError(error);
    }
  }
  async send(input: SendInput, nonce: string): Promise<Message> {
    const c = await this.channel(input.channel_id);
    try {
      const m = (await this.client.rest.post(Routes.channelMessages(input.channel_id), {
        body: {
          content: input.content,
          nonce,
          enforce_nonce: true,
          allowed_mentions: { parse: [], replied_user: false },
          ...(input.reply_to_id
            ? {
                message_reference: {
                  message_id: input.reply_to_id,
                  channel_id: input.channel_id,
                  fail_if_not_exists: true,
                },
              }
            : {}),
        },
      })) as APIMessage;
      return normalizeMessage(m, c.guildId);
    } catch (error) {
      throw discordError(error);
    }
  }
  close(): void {
    this.client.destroy();
  }
}
function discordError(error: unknown): unknown {
  if (error instanceof DiscordAPIError && [10003, 10008, 50001, 50013].includes(Number(error.code)))
    return new PublicError("Discord channel or message is unavailable");
  return error;
}

interface SentRecord {
  fingerprint: string;
  messageId?: string;
}

export class DiscordService {
  constructor(
    readonly port: DiscordPort,
    readonly policy: Policy,
    readonly store: Store,
  ) {}

  async channel(channelId: string): Promise<Channel> {
    const rule = this.policy.rule(channelId);
    const channel = await this.port.channel(channelId);
    if (channel.id !== rule.id || channel.guildId !== rule.guildId)
      throw new PublicError("Channel does not match the configured guild");
    return channel;
  }

  async listChannels(): Promise<unknown[]> {
    return Promise.all(
      this.policy.channels.map(async (rule) => ({
        ...(await this.channel(rule.id)),
        ...this.policy.window(rule.id),
        write: rule.write,
        events: rule.events,
      })),
    );
  }

  async readMessages(
    channelId: string,
    limit: number,
    before?: string,
  ): Promise<{ messages: Message[]; next_before: string | null }> {
    await this.channel(channelId);
    const { from, to } = this.policy.window(channelId);
    if (before) this.policy.message(channelId, before);
    if (from >= to) return { messages: [], next_before: null };
    const page = await this.port.messages(channelId, before ?? snowflakeBefore(to), limit);
    const messages = page.filter((m) => this.isVisible(channelId, m));
    const last = messages.at(-1);
    return { messages, next_before: page.length === limit && last ? last.id : null };
  }

  isVisible(channelId: string, message: Message): boolean {
    const rule = this.policy.rule(channelId);
    return (
      message.channel_id === channelId &&
      message.guild_id === rule.guildId &&
      this.policy.allowsTime(channelId, Date.parse(message.timestamp))
    );
  }

  async getMessage(channelId: string, id: string): Promise<Message> {
    this.policy.message(channelId, id); // Deny old IDs before making a Discord request.
    await this.channel(channelId);
    const message = await this.port.message(channelId, id);
    if (!this.isVisible(channelId, message) || message.id !== id)
      throw new PublicError("Message is outside the permitted scope");
    return message;
  }

  async send(
    owner: string,
    input: SendInput,
  ): Promise<{ id: string; channel_id: string; url: string; reused: boolean }> {
    this.policy.write(input.channel_id);
    await this.channel(input.channel_id);
    if (input.reply_to_id) await this.getMessage(input.channel_id, input.reply_to_id);
    const key = hash(`${owner}\n${input.idempotency_key}`);
    const fingerprint = hash(
      JSON.stringify([input.channel_id, input.content, input.reply_to_id ?? null]),
    );
    const previous = this.store.get<SentRecord>("send", key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new PublicError("Idempotency key was already used for a different message");
    if (previous && !previous.messageId)
      throw new PublicError(
        "Send is pending or its outcome is unknown. Inspect channel history; do not retry with a new key",
      );
    let id = previous?.messageId;
    if (!id) {
      this.store.set("send", key, { fingerprint }, this.store.now() + 7 * 86_400_000);
      try {
        id = (await this.port.send(input, key.slice(0, 24))).id;
      } catch {
        throw new PublicError(
          "Send outcome is unconfirmed. Inspect channel history; do not retry with a new key",
        );
      }
      this.store.set(
        "send",
        key,
        { fingerprint, messageId: id },
        this.store.now() + 7 * 86_400_000,
      );
    }
    return {
      id,
      channel_id: input.channel_id,
      url: `https://discord.com/channels/${this.policy.rule(input.channel_id).guildId}/${input.channel_id}/${id}`,
      reused: Boolean(previous),
    };
  }
}
