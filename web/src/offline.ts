// Offline mode (ADR 0001). The server is the only source of truth; this browser keeps a disposable
// cache of the files it has read, and holds edits it couldn't send as unsent changes, each with the
// revision it was based on. When the server can be reached again, they're sent and merged there like
// any other write, and the cache takes the server's answer. Edits of a data source's records (ADR
// 0007), which go to the server as operations rather than files, wait the same way, in order.
import type { FilePath, FileSummary, Revision, WorkspaceFile, WriteResult } from "../../worker/src/files.ts";
import { ServerAnswer } from "./api.ts";

/** A small key-value store: IndexedDB in the browser, a Map in tests. */
export interface KV {
  get<T>(store: Store, key: string): Promise<T | undefined>;
  set(store: Store, key: string, value: unknown): Promise<void>;
  del(store: Store, key: string): Promise<void>;
  all<T>(store: Store): Promise<T[]>;
}

type Store = "files" | "unsent" | "meta" | "ops";

/** An edit of records the server didn't get: the request to send again, as it was made. */
export interface HeldOp {
  /** When it was made, which is also the order they're sent in. */
  id: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  /** The extension that made it, if it's named as the author. */
  extension?: string;
  /** What it was, in words, for the status bar. */
  what: string;
}

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

/** Whether the server answered that an edit can't be made, so sending it again won't help: a 4xx, but not a sign-in or a busy server. */
const refusal = (err: unknown) => err instanceof ServerAnswer && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status);

export class Offline {
  /** Whether the last request reached the server. */
  online = true;
  /** Held edits of records being sent now, so a second send waits for it rather than sending them again. */
  private sendingOps: Promise<{ sent: number; refused: Array<{ op: HeldOp; error: string }> }> | null = null;
  private held = 0;
  private listeners: Array<() => void> = [];

  constructor(
    private kv: KV,
    private net: Network,
  ) {
    // The browser says its connection went: offline now, rather than at the next request. And when it
    // says it's back, one request says whether the server can be reached, or an idle page says Offline on.
    if (typeof addEventListener !== "undefined") {
      addEventListener("offline", () => this.reached(false));
      addEventListener("online", () => void this.check());
    }
  }

  /** Ask the server whether it can be reached: the list of files, kept as the last seen. */
  async check(): Promise<boolean> {
    await this.list().catch(() => {});
    return this.online;
  }

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

  /** Keep an edit of records that couldn't be sent, to send once the server can be reached. */
  async holdOp(op: Omit<HeldOp, "id">): Promise<HeldOp> {
    // The time, then a count for edits made in the same millisecond, so ids sort in the order they were made.
    const held = { ...op, id: `${String(Date.now()).padStart(15, "0")}-${String(++this.held).padStart(6, "0")}` };
    await this.kv.set("ops", held.id, held);
    this.changed();
    return held;
  }

  async ops(): Promise<HeldOp[]> {
    return (await this.kv.all<HeldOp>("ops")).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Send held edits of records, oldest first, stopping if the server can't be reached or fails. One
   * the server refuses (the event's gone, say) is dropped, and its reason returned. While a send is
   * under way, another call gets that one's result.
   */
  flushOps(send: (op: HeldOp) => Promise<unknown>): Promise<{ sent: number; refused: Array<{ op: HeldOp; error: string }> }> {
    this.sendingOps ??= this.sendOps(send).finally(() => (this.sendingOps = null));
    return this.sendingOps;
  }

  private async sendOps(send: (op: HeldOp) => Promise<unknown>): Promise<{ sent: number; refused: Array<{ op: HeldOp; error: string }> }> {
    let sent = 0;
    const refused: Array<{ op: HeldOp; error: string }> = [];
    for (const op of await this.ops()) {
      try {
        await send(op);
        sent++;
        this.reached(true);
      } catch (err) {
        if (!refusal(err)) {
          if (unreachable(err)) this.reached(false);
          break;
        }
        refused.push({ op, error: (err as Error).message });
      }
      await this.kv.del("ops", op.id);
    }
    if (sent || refused.length) this.changed();
    return { sent, refused };
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
    // Version 2 adds "ops"; upgrading makes whichever stores are missing.
    const open = indexedDB.open(name, 2);
    open.onupgradeneeded = () => {
      for (const store of ["files", "unsent", "meta", "ops"]) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
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
