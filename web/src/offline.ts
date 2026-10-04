// Offline mode (ADR 0001). The server is the only source of truth; this browser keeps a disposable
// cache of the files it has read, and holds edits it couldn't send as unsent changes, each with the
// revision it was based on. When the server can be reached again, they're sent and merged there like
// any other write, and the cache takes the server's answer.
import type { FilePath, FileSummary, Revision, WorkspaceFile, WriteResult } from "../../worker/src/files.ts";

/** A small key-value store: IndexedDB in the browser, a Map in tests. */
export interface KV {
  get<T>(store: Store, key: string): Promise<T | undefined>;
  set(store: Store, key: string, value: unknown): Promise<void>;
  del(store: Store, key: string): Promise<void>;
  all<T>(store: Store): Promise<T[]>;
}

type Store = "files" | "unsent" | "meta";

/** An edit that hasn't reached the server: the file's whole text and the revision it was based on. */
export interface Unsent {
  path: FilePath;
  text: string;
  base: Revision;
  /** The server refused to merge it: the same lines changed there. Opening the file shows what to do. */
  conflict?: boolean;
}

export interface Network {
  list(): Promise<FileSummary[]>;
  read(path: FilePath): Promise<WorkspaceFile>;
  write(path: FilePath, text: string, base: Revision): Promise<WriteResult>;
}

/** Whether an error means the server couldn't be reached, rather than that it answered with a problem. */
export const unreachable = (err: unknown) => err instanceof TypeError || (err as Error)?.name === "TypeError";

export class Offline {
  /** Whether the last request reached the server. */
  online = true;
  private listeners: Array<() => void> = [];

  constructor(
    private kv: KV,
    private net: Network,
  ) {}

  /** Be told when unsent changes or reachability change. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  private reached(ok: boolean) {
    if (this.online !== ok) {
      this.online = ok;
      this.changed();
    }
  }

  /** Every file: from the server, or as last seen, plus files that only exist as unsent changes. */
  async list(): Promise<FileSummary[]> {
    try {
      const files = await this.net.list();
      this.reached(true);
      await this.kv.set("meta", "list", files);
      return files;
    } catch (err) {
      if (!unreachable(err)) throw err;
      this.reached(false);
      const cached = (await this.kv.get<FileSummary[]>("meta", "list")) ?? [];
      const extra = (await this.unsent()).filter((u) => !cached.some((f) => f.path === u.path)).map((u) => ({ path: u.path, revision: 0 }));
      return [...cached, ...extra].sort((a, b) => a.path.localeCompare(b.path));
    }
  }

  /** A file from the server, or as last seen when the server can't be reached. */
  async read(path: FilePath): Promise<WorkspaceFile> {
    try {
      const file = await this.net.read(path);
      this.reached(true);
      await this.kv.set("files", path, file);
      return file;
    } catch (err) {
      if (!unreachable(err)) throw err;
      this.reached(false);
      return (await this.kv.get<WorkspaceFile>("files", path)) ?? { path, text: "", revision: 0 };
    }
  }

  /**
   * Keep a copy of every file whose kept copy is out of date, so they open offline too. A few at a
   * time, in the background; a failure just leaves that copy as it was.
   */
  async warm(files: FileSummary[]): Promise<void> {
    const stale: FileSummary[] = [];
    for (const f of files) if ((await this.kv.get<WorkspaceFile>("files", f.path))?.revision !== f.revision) stale.push(f);
    const next = async (): Promise<void> => {
      const f = stale.shift();
      if (!f) return;
      await this.read(f.path).catch(() => {});
      return next();
    };
    await Promise.all([next(), next(), next(), next()]);
  }

  /** Send a write. Reaching the server keeps its answer in the cache; not reaching it throws, as fetch does. */
  async write(path: FilePath, text: string, base: Revision): Promise<WriteResult> {
    try {
      const result = await this.net.write(path, text, base);
      this.reached(true);
      if (result.file) await this.kv.set("files", path, result.file);
      return result;
    } catch (err) {
      if (unreachable(err)) this.reached(false);
      throw err;
    }
  }

  /** Keep an edit that couldn't be sent, so it survives a reload. */
  async hold(unsent: Unsent): Promise<void> {
    await this.kv.set("unsent", unsent.path, unsent);
    this.changed();
  }

  /** The edit reached the server: let it go. */
  async release(path: FilePath): Promise<void> {
    if (!(await this.kv.get("unsent", path))) return;
    await this.kv.del("unsent", path);
    this.changed();
  }

  unsent(): Promise<Unsent[]> {
    return this.kv.all<Unsent>("unsent");
  }

  unsentFor(path: FilePath): Promise<Unsent | undefined> {
    return this.kv.get<Unsent>("unsent", path);
  }

  /**
   * Send held edits, except those an open editor is sending itself. Each is merged on the server
   * against its base revision; one that can't be merged stays, marked as a conflict.
   */
  async flush(skip: (path: FilePath) => boolean = () => false): Promise<{ sent: FilePath[]; conflicts: FilePath[] }> {
    const sent: FilePath[] = [];
    const conflicts: FilePath[] = [];
    for (const u of await this.unsent()) {
      if (skip(u.path) || u.conflict) continue;
      let result: WriteResult;
      try {
        result = await this.write(u.path, u.text, u.base);
      } catch (err) {
        if (unreachable(err)) break;
        throw err;
      }
      if (result.status === "conflict") {
        conflicts.push(u.path);
        await this.kv.set("unsent", u.path, { ...u, conflict: true });
      } else {
        sent.push(u.path);
        await this.kv.del("unsent", u.path);
      }
    }
    if (sent.length || conflicts.length) this.changed();
    return { sent, conflicts };
  }
}

export function memoryKV(): KV {
  const stores = new Map<string, Map<string, unknown>>();
  const s = (name: string) => stores.get(name) ?? stores.set(name, new Map()).get(name)!;
  return {
    get: async <T>(store: Store, key: string) => s(store).get(key) as T | undefined,
    set: async (store, key, value) => void s(store).set(key, structuredClone(value)),
    del: async (store, key) => void s(store).delete(key),
    all: async <T>(store: Store) => [...s(store).values()] as T[],
  };
}

/** The browser's IndexedDB, as a KV. If IndexedDB isn't there (a private window, say), a memory store stands in. */
export function idbKV(name = "common-ink"): KV {
  if (typeof indexedDB === "undefined") return memoryKV();
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      for (const store of ["files", "unsent", "meta"]) open.result.createObjectStore(store);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const run = async <T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const tx = (await db).transaction(store, mode);
    const req = fn(tx.objectStore(store));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    set: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
    del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
    all: (store) => run(store, "readonly", (s) => s.getAll()),
  };
}
