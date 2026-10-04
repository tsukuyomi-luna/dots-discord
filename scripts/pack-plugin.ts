import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

export function packagePlugin(publicUrl: string): Uint8Array {
  const url = new URL(publicUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port
  )
    throw new Error("Supply a root HTTPS URL, e.g. https://discord.example.org");
  const manifest = readFileSync(new URL("../plugin.json", import.meta.url), "utf8");
  const mcp = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { discord: { type: "streamable-http", url: `${url.origin}/mcp` } },
  };
  // An explicit list, never a recursive zip of the checkout or .env/data.
  return zipSync({
    "plugin.json": strToU8(manifest),
    "mcp.json": strToU8(JSON.stringify(mcp, null, 2) + "\n"),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: pnpm plugin:pack https://your-public-host");
  writeFileSync("dots-discord.zip", packagePlugin(url));
  console.log("Wrote dots-discord.zip (manifest and MCP URL only; no credentials)");
}
