# Hosted on Cloudflare, with offline mode

Common Ink is a hosted app, not local-first. The server is the source of truth, and clients keep a local copy so they can work offline. It runs entirely on Cloudflare: Workers for the API, a Durable Object per workspace to order changes and push them to clients live, D1 for queryable metadata, and R2 for uploads. We chose one platform over a mix of services to keep operations small. The cost is lock-in to Durable Objects' consistency model.

## Consequences

Offline edits are queued as changes against a base revision and rebased when the client reconnects. Sync has to handle concurrent edits from the user and agents. See [0002](0002-history-is-the-source-of-truth.md).
