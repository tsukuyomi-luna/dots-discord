import express, { type ErrorRequestHandler } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { DiscordService } from "./discord.js";
import type { EventService } from "./events.js";
import { createMcp } from "./mcp.js";

export function createApp(
  config: Config,
  auth: Auth,
  discord: DiscordService,
  events: EventService,
  ready: () => boolean = () => true,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  const publicHost = new URL(config.publicUrl).host;
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    });
    if (req.headers.host !== publicHost) {
      res.status(403).json({ error: "invalid_host" });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      if (![config.publicUrl, "https://chatgpt.com"].includes(origin)) {
        res.status(403).json({ error: "invalid_origin" });
        return;
      }
      res.set({
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      });
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.get("/healthz", (_, res) => res.status(ready() ? 200 : 503).json({ ready: ready() }));
  app.use(auth.router());
  let windowStart = 0;
  let requests = 0;
  app.use("/mcp", (req, res, next) => {
    if (!auth.authenticate(req.headers.authorization)) {
      auth.unauthorized(res);
      return;
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 180) {
      res.set("Retry-After", "60").status(429).json({ error: "rate_limit" });
      return;
    }
    next();
  });
  const mcp = createMcp(auth, discord, events);
  app.all(
    "/mcp",
    toNodeHandler(mcp, {
      maxRequestBodySize: 64 * 1024,
      onerror: () => console.error("mcp_http_error"),
    }),
  );
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    void _next; // Four parameters are required for Express to recognize this as an error handler.
    const tooLarge =
      typeof error === "object" && error !== null && "status" in error && error.status === 413;
    res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? "request_too_large" : "invalid_request" });
  };
  app.use(handleError);
  return { app, close: () => mcp.close() };
}
