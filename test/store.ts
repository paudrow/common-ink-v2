import { DataSources, type SourceSettings } from "../worker/src/data-sources.ts";
import { Files } from "../worker/src/files.ts";
import type { Store } from "../worker/src/operations.ts";
import { memoryDb } from "./sqlite.ts";

/** A workspace the way the Durable Object offers it, on in-memory SQLite, with recorded data sources unless told otherwise. */
export function memoryStore(settings: SourceSettings = { fixtures: true, google: null }, fetcher?: typeof fetch) {
  const db = memoryDb();
  const files = new Files(db);
  const sources = new DataSources(db, settings, fetcher);
  const store: Store & { files: Files; sources: DataSources } = {
    files,
    sources,
    list: () => files.list(),
    read: (p) => files.read(p),
    write: (w) => files.write(w),
    recent: (q) => files.recent(q),
    undo: (r, a) => files.undo(r, a),
    combined: (r) => files.combined(r),
    versionAt: (p, r) => files.versionAt(p, r),
    restore: (p, at, a) => files.restore(p, at, a),
    sourceStatus: (e) => sources.status(e),
    events: (e, f, t) => sources.events(e, f, t),
    contacts: (e, q) => sources.contacts(e, q),
  };
  return store;
}
