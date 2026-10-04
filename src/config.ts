import { readFileSync } from "node:fs";
import * as v from "valibot";

export const snowflake = v.pipe(v.string(), v.regex(/^[1-9]\d{16,19}$/));
const instant = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check((s) => Number.isFinite(Date.parse(s))),
);
const hostname = v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/));
const httpsUrl = v.pipe(
  v.string(),
  v.url(),
  v.check((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  }),
);

export const channelRuleSchema = v.strictObject({
  id: snowflake,
  guildId: snowflake,
  since: instant,
  until: v.optional(instant),
  historyHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8760)), 168),
  write: v.optional(v.boolean(), false),
  events: v.optional(v.picklist(["mentions", "all", "off"]), "mentions"),
});
export type ChannelRule = v.InferOutput<typeof channelRuleSchema>;

export const configSchema = v.pipe(
  v.strictObject({
    publicUrl: httpsUrl,
    host: v.optional(v.string(), "127.0.0.1"),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 8788),
    database: v.optional(v.string(), "./data/bridge.sqlite3"),
    oauth: v.strictObject({
      clientId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      redirectUris: v.pipe(v.array(httpsUrl), v.minLength(1), v.maxLength(10)),
    }),
    callbackHosts: v.pipe(v.array(hostname), v.minLength(1), v.maxLength(20)),
    channels: v.pipe(v.array(channelRuleSchema), v.minLength(1), v.maxLength(100)),
  }),
  v.check((c) => {
    const url = new URL(c.publicUrl);
    return (
      url.pathname === "/" &&
      !url.search &&
      !url.port &&
      new Set(c.channels.map((r) => r.id)).size === c.channels.length &&
      c.channels.every((r) => !r.until || Date.parse(r.until) > Date.parse(r.since))
    );
  }, "Use a root HTTPS public URL and unique channel IDs with valid time ranges"),
);
export type Config = v.InferOutput<typeof configSchema>;
export interface Secrets {
  botToken: string;
  clientSecret: string;
  ownerPassword: string;
}

export function loadConfig(path: string): Config {
  const result = v.safeParse(configSchema, JSON.parse(readFileSync(path, "utf8")));
  if (!result.success)
    throw new Error("Invalid config.json; check config.example.json (no secret values logged)");
  return { ...result.output, publicUrl: new URL(result.output.publicUrl).origin };
}

export function loadSecrets(env: NodeJS.ProcessEnv): Secrets {
  const required = (name: string) => {
    const value = env[name];
    if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
    return value;
  };
  const secrets = {
    botToken: required("DISCORD_BOT_TOKEN"),
    clientSecret: required("OAUTH_CLIENT_SECRET"),
    ownerPassword: required("OWNER_PASSWORD"),
  };
  if (new Set(Object.values(secrets)).size !== 3) throw new Error("Secrets must be different");
  return secrets;
}
