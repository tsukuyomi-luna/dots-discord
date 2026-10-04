import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { packagePlugin } from "../scripts/pack-plugin.js";

test("plugin ZIP contains only the public manifests and configured MCP URL", () => {
  const files = unzipSync(packagePlugin("https://bridge.example.org/"));
  assert.deepEqual(Object.keys(files).sort(), ["mcp.json", "plugin.json"]);
  const manifest = JSON.parse(strFromU8(files["plugin.json"]!));
  assert.equal(manifest.name, "dots-discord");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.deepEqual(JSON.parse(strFromU8(files["mcp.json"]!)), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { discord: { type: "streamable-http", url: "https://bridge.example.org/mcp" } },
  });
});

test("plugin packaging rejects non-HTTPS URLs, credentials, ports and paths", () => {
  for (const url of [
    "http://bridge.example.org",
    "https://secret@bridge.example.org",
    "https://bridge.example.org:8443",
    "https://bridge.example.org/mcp",
    "https://bridge.example.org?token=secret",
    "https://bridge.example.org#fragment",
  ])
    assert.throws(() => packagePlugin(url));
});
