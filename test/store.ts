import { openWorkspace, restoreFile, undoChanges, type SourceSettings } from "../worker/src/data-sources.ts";
import type { Adapter } from "../worker/src/adapter.ts";
import type { Store } from "../worker/src/operations.ts";
import { addUpload, type Blobs } from "../worker/src/uploads.ts";
import type { DataSources } from "../worker/src/data-sources.ts";
import type { Files } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

/** R2, as a Map from key to bytes. */
export function memoryBlobs(): Blobs & { data: Map<string, ArrayBuffer> } {
  const data = new Map<string, ArrayBuffer>();
  return { data, has: async (k) => data.has(k), put: async (k, d) => void data.set(k, d) };
}

/** A workspace the way the Durable Object offers it, on in-memory SQLite, with recorded data sources unless told otherwise. */
export function memoryStore(settings: SourceSettings = { fixtures: true, google: null }, fetcher?: typeof fetch, adapters: Adapter[] = [], now?: () => number) {
  const db = memoryDb();
  const { files, sources } = openWorkspace(db, settings, undefined, fetcher, adapters, now);
  const blobs = memoryBlobs();
  const store: Store & { files: Files; sources: DataSources; blobs: typeof blobs; db: typeof db } = {
    files,
    sources,
    blobs,
    db,
    list: () => files.list(),
    read: (p) => files.read(p),
    write: (w) => files.write(w),
    recent: (q) => files.recent(q),
    undo: (r, a) => undoChanges(files, sources, r, a),
    combined: (r) => files.combined(r),
    versionAt: (p, r) => files.versionAt(p, r),
    restore: (p, at, a) => restoreFile(files, sources, p, at, a),
    sourceStatus: (e) => sources.status(e),
    calendars: () => sources.calendars(),
    events: (f, t, z, c) => sources.events(f, t, z, c),
    event: (address, zone) => sources.event(address, zone),
    editEvent: (edit, a, zone) => sources.edit(edit, a, zone),
    syncSources: async (force) => {
      if (force || sources.due(30_000)) await sources.sync();
      return sources.status("").sources[0];
    },
    contacts: (e, q) => sources.contacts(e, q),
    upload: (n, d, a) => addUpload(files, blobs, n, d, a),
  };
  return store;
}
