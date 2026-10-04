import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import {
  callbackUrl,
  publicAddress,
  secureWebhookPost,
  signedHeaders,
  signingSecret,
} from "../src/webhook.js";
import { secret } from "./fixtures.js";

test("callbacks must be exact allowlisted HTTPS hosts without userinfo/redirect tricks", () => {
  const hosts = ["callback.example.org"];
  assert.equal(callbackUrl("https://callback.example.org/a?key=ok", hosts).hostname, hosts[0]);
  for (const url of [
    "http://callback.example.org",
    "https://callback.example.org.evil.org",
    "https://user:pass@callback.example.org",
    "https://callback.example.org:8080/",
    "https://callback.example.org/#secret",
    "https://localhost/",
  ]) {
    assert.throws(() => callbackUrl(url, hosts));
  }
});
test("private/reserved/transition IPv4 and IPv6 are denied", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.51.100.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "ff02::1",
    "garbage",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("even an explicitly listed private host cannot reach a socket", async () => {
  await assert.rejects(
    secureWebhookPost(["127.0.0.1"])("https://127.0.0.1/", "{}", {}),
    /rejected/,
  );
});
test("secret shape is strict and HMAC matches Standard Webhooks", () => {
  signingSecret(secret);
  for (const invalid of [
    "x",
    "whsec_a===",
    `whsec_${Buffer.alloc(12).toString("base64")}`,
    `whsec_${Buffer.alloc(100).toString("base64")}`,
  ])
    assert.throws(() => signingSecret(invalid));
  const body = JSON.stringify({ eventId: "event_1", text: "こんにちは" });
  const headers = signedHeaders("event_1", "sub_1", body, [secret], Date.now());
  assert.deepEqual(new Webhook(secret).verify(body, headers), JSON.parse(body));
  assert.throws(() => new Webhook(secret).verify(body + " ", headers));
  assert.throws(() => signedHeaders("x", "y", "x".repeat(262145), [secret], Date.now()));
});
