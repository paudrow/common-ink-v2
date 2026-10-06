# Hosted on Cloudflare, with offline mode

Common Ink is a hosted app, not local-first. The database lives on our servers, and they are the only source of truth. It runs entirely on Cloudflare: Workers for the API, a Durable Object per workspace to order changes and push them to clients live, D1 for queryable metadata, and R2 for uploads. We chose one platform over a mix of services to keep operations small. The cost is lock-in to Durable Objects' consistency model.

Offline mode is a fallback, not a second home for the data. Clients keep a cache of downloaded notes, and while disconnected they record edits as temporary local changes. On reconnect, a change is sent against its base revision when the note hasn't changed since. If it has, the change is held for you to restore (merged onto the note as it is now) or discard, so nothing is merged unseen. Each change carries an id, so one the server already has is never applied twice. Then the local copy is replaced by the server's.

## Considered Options

- **Local-first (local files or a CRDT as the source of truth):** rejected. It adds sync complexity to every feature and splits the truth across devices.

## Consequences

The local cache is disposable. Losing it only loses changes that haven't been sent yet, so the UI must show when unsent changes exist. Data sources and uploads not already cached are unavailable offline. See [0002](0002-history-is-the-source-of-truth.md) for how merges work.
