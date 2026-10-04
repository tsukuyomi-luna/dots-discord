import type { ChannelRule } from "./config.js";
import { PublicError } from "./errors.js";

const DISCORD_EPOCH = 1420070400000n;
export function snowflakeTime(id: string): number {
  if (!/^[1-9]\d{16,19}$/.test(id)) throw new PublicError("Invalid Discord ID");
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
export function snowflakeBefore(time: number): string {
  return ((BigInt(Math.floor(time)) - DISCORD_EPOCH) << 22n).toString();
}

export class Policy {
  constructor(
    readonly channels: readonly ChannelRule[],
    readonly now = Date.now,
  ) {}

  rule(channelId: string): ChannelRule {
    const rule = this.channels.find((r) => r.id === channelId);
    if (!rule) throw new PublicError("Channel is not allowed");
    return rule;
  }

  window(channelId: string): { from: number; to: number } {
    const rule = this.rule(channelId);
    return {
      from: Math.max(Date.parse(rule.since), this.now() - rule.historyHours * 3_600_000),
      to: Math.min(rule.until ? Date.parse(rule.until) : Infinity, this.now() + 1),
    };
  }

  allowsTime(channelId: string, time: number): boolean {
    const { from, to } = this.window(channelId);
    return time >= from && time < to;
  }

  message(channelId: string, messageId: string): void {
    if (!this.allowsTime(channelId, snowflakeTime(messageId)))
      throw new PublicError("Message is outside the permitted history window");
  }

  write(channelId: string): void {
    if (!this.rule(channelId).write || !this.allowsTime(channelId, this.now()))
      throw new PublicError("Sending to this channel is not allowed");
  }

  event(channelId: string, mentionsOnly: boolean): void {
    const mode = this.rule(channelId).events;
    if (
      mode === "off" ||
      (mode === "mentions" && !mentionsOnly) ||
      !this.allowsTime(channelId, this.now())
    ) {
      throw new PublicError("This event filter is not allowed");
    }
  }
}
