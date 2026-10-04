# Security model

This is a single-operator, self-hosted bridge, not a multi-tenant OAuth service. Do not share its owner password or connect unrelated users to the same instance.

- One pre-registered confidential client, exact redirect URI allowlist, PKCE S256, resource binding, issuer-bearing authorization responses
- Owner approval tied to a short-lived ticket and Secure / HttpOnly cookie; same-origin POST; random owner password required
- Opaque access/refresh tokens and authorization codes are stored only as hashes. Refresh-token reuse revokes the grant
- Discord access is the intersection of configured channel/guild/time policy and the Bot's Discord permissions. Never grant Administrator
- Reply targets use the same read boundary. No automatic access to embeds, forwarded messages, referenced messages, DMs or external links
- Callback verification and every delivery re-resolve DNS and block non-public addresses. The TLS socket connects to the checked address with the original hostname as SNI. No redirects or ambient proxy variables
- Callbacks also require an exact configured hostname. Only operators may change that allowlist; requests and message content cannot do so
- Bots and webhooks never trigger events. Outbound messages use `allowed_mentions: { parse: [], replied_user: false }`
- Send keys are persisted before Discord I/O. A crash/timeout leaves an unknown state that is not automatically retried

## Stored data

`data/` contains OAuth grants, hashed tokens, subscription callback URLs and signing secrets, deduplication metadata, and temporarily queued message bodies. Callback secrets are not encrypted at rest: protect the filesystem and backups. The process uses umask 0077; database mode is 0600.

Queue bodies are deleted after delivery or terminal failure, on unsubscribe, when edited/deleted before delivery, or within 24 hours. Grant/policy revocation is checked again before delivery. One already in-flight request may finish. Deletion does not recall bytes already delivered to dots or remove copies from backups. SQLite secure-delete and WAL checkpointing are best-effort hygiene, not a secure-erasure guarantee.

The source checkout does not need secrets. `.env`, `config.json`, databases, logs and generated ZIPs are ignored by Git. Packaging enumerates two public manifest files instead of archiving the checkout. Do not log full request bodies, authorization headers, callback URLs or Discord messages at the reverse proxy.

Keep the origin bound to loopback behind a TLS proxy. Preserve the configured public Host header. Add infrastructure-level connection/rate limits and disk monitoring. Run only one process per database. Changing configuration requires a restart; expired or newly denied subscriptions are removed on the next worker tick.

For suspected credential disclosure, stop the bridge, revoke the Discord token and rotate both OAuth secrets. Existing token families can be invalidated by stopping the bridge and removing its database (this also removes subscriptions and queued deliveries), then reconnecting. Do not put tokens or message contents in a public GitHub issue.

Local tests are not an independent security audit. Before handling sensitive channels, review the implementation and complete a real authorization, delivery, unsubscribe and permission-revocation test on your own deployment.
