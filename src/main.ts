import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { Auth } from "./auth.js";
import { createApp } from "./app.js";
import { loadConfig, loadSecrets } from "./config.js";
import { DiscordService, LiveDiscord } from "./discord.js";
import { EventService } from "./events.js";
import { Policy } from "./policy.js";
import { Store } from "./store.js";
import { secureWebhookPost } from "./webhook.js";

process.umask(0o077);
if (existsSync(".env")) loadEnvFile(".env");
const config = loadConfig(process.env.CONFIG_PATH ?? "config.json");
const secrets = loadSecrets(process.env);
const store = new Store(config.database);
const auth = new Auth(config, secrets, store);
const live = new LiveDiscord();
const discord = new DiscordService(live, new Policy(config.channels), store);
const events = new EventService(
  store,
  discord,
  auth,
  secureWebhookPost(config.callbackHosts),
  config.callbackHosts,
);
const { app, close } = createApp(config, auth, discord, events, () => live.client.isReady());

try {
  await live.start(
    secrets.botToken,
    (message) => events.enqueue(message),
    (id) => events.removeMessage(id),
  );
  await discord.listChannels(); // Fail startup on a wrong guild/channel/permission.
} catch {
  live.close();
  store.close();
  console.error(
    "startup_failed: check Discord token, intents, allowed channels and bot permissions",
  );
  process.exit(1);
}
const http = app.listen(config.port, config.host, () => console.log("bridge_listening"));
const timer = setInterval(() => {
  void events.tick().catch(() => console.error("event_worker_failed"));
}, 1000);
timer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  live.close();
  http.close();
  await close();
  // In-flight callbacks have a 10-second deadline. No new queue work starts.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 11_000).unref();
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
