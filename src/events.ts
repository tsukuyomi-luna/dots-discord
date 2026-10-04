import * as v from "valibot";
import type { Grant, Auth } from "./auth.js";
import { snowflake } from "./config.js";
import { hash, randomToken, sameSecret } from "./crypto.js";
import type { DiscordService, Message } from "./discord.js";
import { CallbackError, PublicError } from "./errors.js";
import { Store } from "./store.js";
import { callbackUrl, signedHeaders, signingSecret, type WebhookPost } from "./webhook.js";

export const eventArguments = v.strictObject({
  channel_id: snowflake,
  mentions_only: v.optional(v.boolean(), true),
});
export const subscribeParams = v.object({
  name: v.literal("message.created"),
  arguments: eventArguments,
  delivery: v.strictObject({
    mode: v.literal("webhook"),
    url: v.pipe(v.string(), v.maxLength(4096)),
    secret: v.pipe(v.string(), v.maxLength(100)),
  }),
  cursor: v.optional(v.null(), null),
  ttlMs: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
});
export const unsubscribeParams = v.object({
  name: v.literal("message.created"),
  arguments: eventArguments,
  delivery: v.object({ mode: v.literal("webhook"), url: v.pipe(v.string(), v.maxLength(4096)) }),
});
export type Subscribe = v.InferOutput<typeof subscribeParams>;
type Identity = v.InferOutput<typeof unsubscribeParams>;
export interface Subscription {
  id: string;
  owner: string;
  grantId: string;
  channel: string;
  mentionsOnly: boolean;
  url: string;
  secret: string;
  expires: number;
  previousSecret?: string;
  previousUntil?: number;
}
interface Delivery {
  id: number;
  subscription: string;
  event: string;
  message: string;
  body: string;
  fingerprint: string;
  attempts: number;
  next_attempt: number;
  expires: number;
}

export function subscriptionId(owner: string, params: Identity): string {
  // Fixed fields are canonical regardless of caller object key order.
  return `sub_${hash(JSON.stringify([owner, params.delivery.url, params.name, params.arguments.channel_id, params.arguments.mentions_only]))}`;
}
export function messageFingerprint(message: Message): string {
  return hash(
    JSON.stringify([
      message.id,
      message.channel_id,
      message.guild_id,
      message.author.id,
      message.content,
      message.edited_timestamp ? Date.parse(message.edited_timestamp) : null,
      message.attachments.map((a) => [a.id, a.filename]),
      message.reply_to_id,
    ]),
  );
}

export class EventService {
  private locks = new Map<string, Promise<unknown>>();
  private running = false;
  constructor(
    readonly store: Store,
    readonly discord: DiscordService,
    readonly auth: Auth,
    readonly post: WebhookPost,
    readonly hosts: readonly string[],
  ) {}

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const current = before.catch(() => {}).then(work);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async subscribe(grant: Grant, params: Subscribe): Promise<object> {
    this.discord.policy.event(params.arguments.channel_id, params.arguments.mentions_only);
    await this.discord.channel(params.arguments.channel_id);
    callbackUrl(params.delivery.url, this.hosts);
    signingSecret(params.delivery.secret);
    const id = subscriptionId(grant.principal, params);
    return this.locked(id, async () => {
      if (!this.store.get("subscription", id) && this.store.list("subscription").length >= 32)
        throw new PublicError("Subscription limit reached");
      const verifyKey = hash(
        JSON.stringify([grant.principal, params.delivery.url, hash(params.delivery.secret)]),
      );
      if (!this.store.get("verified", verifyKey)) {
        const body = JSON.stringify({ type: "verification", challenge: randomToken() });
        const parsed = JSON.parse(body) as { challenge: string };
        const response = await this.post(
          params.delivery.url,
          body,
          signedHeaders(
            `verify_${randomToken()}`,
            id,
            body,
            [params.delivery.secret],
            this.store.now(),
          ),
        );
        let echoed: unknown;
        try {
          echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge;
        } catch {
          /* Invalid JSON is not a verification. */
        }
        if (
          response.status < 200 ||
          response.status >= 300 ||
          typeof echoed !== "string" ||
          !sameSecret(echoed, parsed.challenge)
        )
          throw new CallbackError("challenge_failed");
        this.store.set("verified", verifyKey, true, this.store.now() + 5 * 60_000);
      }
      if (!this.auth.grant(grant.id)) throw new PublicError("Authorization has expired");
      this.discord.policy.event(params.arguments.channel_id, params.arguments.mentions_only);
      const expires = Math.min(
        this.store.now() + Math.max(60_000, Math.min(params.ttlMs ?? 86_400_000, 86_400_000)),
        grant.expires,
      );
      const previous = this.store.get<Subscription>("subscription", id);
      const subscription: Subscription = {
        id,
        owner: grant.principal,
        grantId: grant.id,
        channel: params.arguments.channel_id,
        mentionsOnly: params.arguments.mentions_only,
        url: params.delivery.url,
        secret: params.delivery.secret,
        expires,
      };
      if (previous && previous.secret !== subscription.secret) {
        subscription.previousSecret = previous.secret;
        subscription.previousUntil = this.store.now() + 5 * 60_000;
      } else if (previous?.previousUntil && previous.previousUntil > this.store.now()) {
        subscription.previousSecret = previous.previousSecret;
        subscription.previousUntil = previous.previousUntil;
      }
      this.store.set("subscription", id, subscription, expires);
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    });
  }

  async unsubscribe(grant: Grant, params: Identity): Promise<object> {
    const id = subscriptionId(grant.principal, params);
    return this.locked(id, async () => {
      this.remove(id);
      return {};
    });
  }
  private remove(id: string): void {
    this.store.transaction(() => {
      this.store.delete("subscription", id);
      this.store.db.prepare("DELETE FROM deliveries WHERE subscription=?").run(id);
    });
  }
  removeMessage(id: string): void {
    this.store.db.prepare("DELETE FROM deliveries WHERE message=?").run(id);
  }

  enqueue(message: Message): void {
    if (message.author.bot || message.webhook || message.author.id === this.discord.port.botId)
      return;
    for (const { value: sub } of this.store.list<Subscription>("subscription")) {
      try {
        if (
          message.channel_id !== sub.channel ||
          !this.auth.grant(sub.grantId) ||
          !this.discord.isVisible(sub.channel, message)
        )
          continue;
        this.discord.policy.event(sub.channel, sub.mentionsOnly);
        if (sub.mentionsOnly && !message.mentions.includes(this.discord.port.botId)) continue;
        const eventId = `discord_${message.id}`;
        const seen = hash(`${sub.id}\n${eventId}`);
        if (this.store.get("seen", seen)) continue;
        const body = JSON.stringify({
          eventId,
          name: "message.created",
          timestamp: new Date(message.timestamp).toISOString(),
          data: message,
          cursor: null,
        });
        if (Buffer.byteLength(body) > 256 * 1024) {
          console.warn("event_payload_too_large");
          continue;
        }
        const count = this.store.db.prepare("SELECT count(*) AS count FROM deliveries").get();
        if (Number(count?.count) >= 1024) {
          console.warn("event_queue_full");
          continue;
        }
        const expires = Math.min(sub.expires, this.store.now() + 86_400_000);
        this.store.transaction(() => {
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO deliveries(subscription,event,message,body,fingerprint,next_attempt,expires) VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              sub.id,
              eventId,
              message.id,
              body,
              messageFingerprint(message),
              this.store.now(),
              expires,
            );
          this.store.set("seen", seen, true, this.store.now() + 86_400_000);
        });
      } catch (error) {
        if (!(error instanceof PublicError)) console.error("event_enqueue_failed");
      }
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const { value: sub } of this.store.list<Subscription>("subscription")) {
        try {
          if (!this.auth.grant(sub.grantId)) {
            this.remove(sub.id);
            continue;
          }
          this.discord.policy.event(sub.channel, sub.mentionsOnly);
        } catch {
          this.remove(sub.id);
        }
      }
      this.store.purge();
      // At most one event per subscription per tick, preserving FIFO per stream.
      const rows = this.store.db
        .prepare(
          "SELECT * FROM deliveries d WHERE next_attempt<=? AND id=(SELECT min(id) FROM deliveries WHERE subscription=d.subscription) ORDER BY id LIMIT 16",
        )
        .all(this.store.now()) as unknown as Delivery[];
      await Promise.all(rows.map((row) => this.deliver(row)));
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: Delivery): Promise<void> {
    const sub = this.store.get<Subscription>("subscription", row.subscription);
    const drop = () => this.store.db.prepare("DELETE FROM deliveries WHERE id=?").run(row.id);
    if (!sub || !this.auth.grant(sub.grantId)) {
      drop();
      return;
    }
    let retryAfter: string | undefined;
    try {
      const fresh = await this.discord.getMessage(sub.channel, row.message);
      if (messageFingerprint(fresh) !== row.fingerprint) {
        drop();
        return;
      }
      // Recheck after Discord I/O: unsubscribe/revoke/delete may have raced it.
      if (
        !this.store.get("subscription", sub.id) ||
        !this.auth.grant(sub.grantId) ||
        !this.store.db.prepare("SELECT id FROM deliveries WHERE id=?").get(row.id)
      ) {
        drop();
        return;
      }
      const secrets = [sub.secret];
      if (sub.previousSecret && (sub.previousUntil ?? 0) > this.store.now())
        secrets.push(sub.previousSecret);
      const response = await this.post(
        sub.url,
        row.body,
        signedHeaders(row.event, sub.id, row.body, secrets, this.store.now()),
      );
      if (response.status >= 200 && response.status < 300) {
        drop();
        return;
      }
      if ([404, 410].includes(response.status)) {
        this.remove(sub.id);
        return;
      }
      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        drop();
        console.warn("event_delivery_rejected");
        return;
      }
      retryAfter = response.retryAfter;
    } catch (error) {
      if (
        error instanceof CallbackError &&
        !["timeout", "dns_failed", "network_error"].includes(error.reason)
      ) {
        this.remove(sub.id);
        console.warn("event_callback_blocked");
        return;
      }
      if (error instanceof PublicError && !(error instanceof CallbackError)) {
        drop();
        return;
      }
    }
    const attempts = row.attempts + 1;
    if (attempts >= 8) {
      drop();
      console.warn("event_retry_exhausted");
      return;
    }
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAfter
        ? Date.parse(retryAfter) - this.store.now()
        : 0;
    const delay = Math.min(
      3_600_000,
      Math.max(
        Number.isFinite(requested) ? requested : 0,
        1000 * 2 ** attempts + Math.floor(Math.random() * 1000),
      ),
    );
    this.store.db
      .prepare("UPDATE deliveries SET attempts=?,next_attempt=? WHERE id=?")
      .run(attempts, this.store.now() + delay, row.id);
  }
}
