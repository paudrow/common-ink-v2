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
  /** Whether what's kept outlives the page (IndexedDB), rather than only this page (memory). */
  durable?(): Promise<boolean>;
  keys(store: Store): Promise<string[]>;
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
  /** The id this text was sent with, to ask the server whether it landed. */
  edit?: string;
  /** When this browser kept it, for saying so ("Unsaved edit from 10:42"). */
  time?: number;
  /** The page that kept it: only that page lets go of it for being undone or saved. */
  owner?: string;
  /** In what order it was kept, among everything this browser keeps: a clock can be set back, this can't. */
  seq?: number;
}

export interface Network {
  list(): Promise<FileSummary[]>;
  read(path: FilePath): Promise<WorkspaceFile>;
  write(path: FilePath, text: string, base: Revision, edit?: string): Promise<WriteResult>;
  /** Whether the server applied the edit sent with this id. */
  editApplied(path: FilePath, edit: string): Promise<boolean>;
}

/** Whether an error means the server couldn't be reached, rather than that it answered with a problem. */
export const unreachable = (err: unknown) => err instanceof TypeError || (err as Error)?.name === "TypeError";

/** Whether the server answered that an edit can't be made, so sending it again won't help: a 4xx, but not a sign-in or a busy server. */
const refusal = (err: unknown) => err instanceof ServerAnswer && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status);

/** How long the server is sure to know an edit's id: a day short of the 30 it keeps them, for clocks. */
const KNOWN_DAYS = 29;

/** What a kept edit is, against the server's latest: there already, to send, or a clash to show. */
type Verdict = "landed" | "send" | "clash";

/** Files the workspace's list never has: the default settings the server makes up, and data sources' records, listed by kind. */
const unlisted = (path: string) => path.startsWith(".common-ink/defaults/") || path.startsWith(".common-ink/records/");

/** Where a note's unsaved edit is kept, by path, as the page goes. */
const DRAFT = "common-ink.draft:";
/** Where a page marks the notes it let go of its edits of: by page and path. */
const CLEAN = "common-ink.clean:";
/** Every key in localStorage, read before any is removed. */
const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);

/** The last order number this browser gave something it kept. */
const SEQ = "common-ink.seq";

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
      // Copies of files the workspace no longer has (deleted, or deleted forever) aren't kept. Files a
      // list never has stay: the default settings the server makes up, and data sources' records.
      const there = new Set(files.map((f) => f.path));
      for (const path of await this.kv.keys("files")) if (!there.has(path as FilePath) && !unlisted(path)) await this.kv.del("files", path);
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
  async write(path: FilePath, text: string, base: Revision, edit?: string): Promise<WriteResult> {
    try {
      const result = await this.net.write(path, text, base, edit);
      this.reached(true);
      if (result.file) await this.kv.set("files", path, result.file);
      return result;
    } catch (err) {
      if (unreachable(err)) this.reached(false);
      throw err;
    }
  }

  /** This page, among the pages of the app open in this browser. */
  readonly page = Math.random().toString(36).slice(2);
  private seqHere = 0;

  /** The next order number: kept in localStorage, so it counts up across pages and reloads. */
  private nextSeq(): number {
    try {
      const next = Math.max(Number(localStorage.getItem(SEQ)) || 0, this.seqHere) + 1;
      localStorage.setItem(SEQ, String(next));
      return (this.seqHere = next);
    } catch {
      return ++this.seqHere;
    }
  }

  /** Keep an edit that couldn't be sent, so it survives a reload. */
  async hold(unsent: Unsent): Promise<void> {
    // Its place in the order is now: the page letting go of it while it's being kept comes after.
    const seq = this.nextSeq();
    // When it was first held: held again as its sends keep failing, it's still the edit from then.
    const before = unsent.time === undefined ? await this.unsentFor(unsent.path) : undefined;
    const time = unsent.time ?? (before && before.edit === unsent.edit ? before.time : undefined) ?? Date.now();
    await this.kv.set("unsent", unsent.path, { ...unsent, time, owner: unsent.owner ?? this.page, seq });
    this.changed();
  }

  /**
   * A note was deleted forever at a path another note has now: the held edit and the draft kept for
   * it, made on a revision that's `gone`, go too. Those for the note there now stay.
   */
  async forgetPurged(path: FilePath, gone: (revision: Revision) => Promise<boolean>): Promise<void> {
    const held = await this.unsentFor(path);
    if (held && held.base > 0 && (await gone(held.base))) await this.release(path);
    const draft = await this.draftFor(path);
    if (draft && draft.base > 0 && (await gone(draft.base))) await this.dropDraft(path);
  }

  /** The edit reached the server: let it go. */
  async release(path: FilePath): Promise<void> {
    if (!(await this.kv.get("unsent", path))) return;
    await this.kv.del("unsent", path);
    this.changed();
  }

  /** Whether unsent edits outlive the page: false when this browser keeps them in memory only. */
  async durable(): Promise<boolean> {
    return (await this.kv.durable?.()) ?? true;
  }

  /** The edits held to send. One its page has since let go of (undone) goes here, so nothing sends it. */
  async unsent(): Promise<Unsent[]> {
    const held: Unsent[] = [];
    for (const u of await this.kv.all<Unsent>("unsent")) if (!(await this.droppedIfLetGo(u))) held.push(u);
    return held;
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

  async unsentFor(path: FilePath): Promise<Unsent | undefined> {
    const held = await this.kv.get<Unsent>("unsent", path);
    return held && !(await this.droppedIfLetGo(held)) ? held : undefined;
  }

  /** Who's signed in: drafts are kept for them alone, and none without one. */
  account: string | null = null;

  private draftKey(path: FilePath) {
    return `${DRAFT}${this.account}:${path}`;
  }

  /**
   * Keep what an open note's editor has that isn't saved yet, as it's typed: a page that goes before
   * its save does (a reload, a closed tab, its last request lost) finds it here when the note opens
   * again. Quietly: it isn't waiting to be sent, it's only kept.
   */
  async keepDraft(unsent: Unsent): Promise<void> {
    if (this.account) await this.kv.set("meta", this.draftKey(unsent.path), { ...unsent, time: Date.now(), owner: this.page, seq: this.nextSeq() });
  }

  /**
   * Keep unsaved edits at once, as the page goes. IndexedDB's writes may not finish before it's gone;
   * localStorage's do.
   */
  keepDraftsNow(drafts: Unsent[]): void {
    if (!this.account) return;
    for (const d of drafts) {
      try {
        localStorage.setItem(this.draftKey(d.path), JSON.stringify({ ...d, time: Date.now(), owner: this.page, seq: this.nextSeq() }));
      } catch {
        // Full, or not allowed: the draft kept as it was typed is the one there is.
      }
    }
  }

  /**
   * This page lets go of its edits of these notes (whenever one is no more: undone, saved, reloaded, or
   * the note opened as saved): said at once, before anything kept of them is let go of, which may not
   * finish before the page goes (or reach IndexedDB at all, once it keeps to memory). Whatever this page
   * kept of them before now is no edit to anyone. Signed in or not: held edits are kept either way.
   */
  keepCleanNow(paths: FilePath[]): void {
    for (const path of paths) {
      try {
        localStorage.setItem(this.cleanKey(this.page, path), String(this.nextSeq()));
      } catch {
        // Not allowed: the letting go as it happened is what there is.
      }
    }
  }

  private cleanKey(page: string, path: FilePath) {
    return `${CLEAN}${page}:${path}`;
  }

  /** The order number of a page's mark that it went with its edits of a note undone, if it left one. */
  private cleanMark(page: string | undefined, path: FilePath): number | undefined {
    if (!page) return undefined;
    try {
      const mark = localStorage.getItem(this.cleanKey(page, path));
      return mark === null ? undefined : Number(mark);
    } catch {
      return undefined;
    }
  }

  /** Every page's mark for a note goes: what they were about is gone. */
  private dropCleanMarks(path: FilePath) {
    try {
      // A page's id has no colon in it: what follows the first one is the path.
      for (const key of storedKeys()) if (key.startsWith(CLEAN) && key.slice(key.indexOf(":", CLEAN.length) + 1) === path) localStorage.removeItem(key);
    } catch {
      // Nothing to drop.
    }
  }

  /**
   * Whether the page that kept this edit has let go of its edits of the note since (its mark is later):
   * then it's no edit, and it goes from where it was kept. Every read of what's kept comes through here.
   */
  private async droppedIfLetGo(kept: Unsent, where: "held" | "went" | "typed" = "held"): Promise<boolean> {
    const mark = this.cleanMark(kept.owner, kept.path);
    if (mark === undefined || (kept.seq ?? 0) > mark) return false;
    if (where === "held") await this.kv.del("unsent", kept.path);
    else if (where === "typed") await this.kv.del("meta", this.draftKey(kept.path));
    else
      try {
        localStorage.removeItem(this.draftKey(kept.path));
      } catch {
        // Not there.
      }
    return true;
  }

  /** What was kept in localStorage for a note as the page went. */
  private keptAsWent(path: FilePath): Unsent | undefined {
    try {
      const kept = localStorage.getItem(this.draftKey(path));
      return kept ? (JSON.parse(kept) as Unsent) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The note's edit that wasn't saved as the page went: kept then, or else as it was typed. */
  private async draftFor(path: FilePath): Promise<Unsent | undefined> {
    if (!this.account) return undefined;
    let went = this.keptAsWent(path);
    let typed = await this.kv.get<Unsent>("meta", this.draftKey(path));
    if (went && (await this.droppedIfLetGo(went, "went"))) went = undefined;
    if (typed && (await this.droppedIfLetGo(typed, "typed"))) typed = undefined;
    // The later kept of the two: a page that went and came back (the browser's back-forward cache) kept
    // on typing after the one kept as it went. By their order numbers, or their times if kept before those.
    const later = (a: Unsent, b: Unsent) => ((a.seq ?? 0) - (b.seq ?? 0) || (a.time ?? 0) - (b.time ?? 0)) > 0;
    return went && typed ? (later(typed, went) ? typed : went) : (went ?? typed);
  }

  /**
   * This page takes over a kept edit it opened a note with: from now on it's this page's to let go of
   * (by saving it, or undoing it), wherever it was kept.
   */
  private async takeOver(edit: Unsent, held: boolean): Promise<Unsent> {
    const mine = { ...edit, owner: this.page };
    if (held) await this.kv.set("unsent", edit.path, { ...mine, seq: this.nextSeq() });
    else if (this.account) {
      await this.keepDraft(mine);
      try {
        localStorage.removeItem(this.draftKey(edit.path));
      } catch {
        // Not there.
      }
    }
    return mine;
  }

  /**
   * The edit this browser kept of a note that the server may not have, as the note opens with the
   * server's `latest`: one it couldn't send (held), or one typed as the page went (a draft). Sending
   * one the server already has would bring back what was changed or deleted since, and merging one it
   * doesn't have into a note that's moved on would do it unseen. So:
   * - the server's text, or an edit the server says it applied, got there: it goes;
   * - one based on the server's latest picks up where it left off, to be sent;
   * - otherwise it's a clash, kept and shown for you to restore or discard.
   * Offline, a held edit is used as it was; a draft waits, unused, until the server can say.
   */
  async keptEdit(latest: WorkspaceFile): Promise<{ edit: Unsent; clash: boolean; checked: boolean } | undefined> {
    const held = await this.unsentFor(latest.path);
    const kept = held ?? (await this.draftFor(latest.path));
    // Nothing kept (or only what its pages let go of): their marks have done their work.
    if (!kept) return void this.dropCleanMarks(latest.path);
    // Used to open the note, it's this page's to carry on from here; one only kept (offline) stays as it was.
    const take = (edit: Unsent) => this.takeOver(edit, !!held);
    // A clash typed back to the server's own text is no clash.
    if (held?.conflict && this.online && held.text === latest.text) return void (await this.landed(latest.path));
    if (held?.conflict) return { edit: await take(kept), clash: true, checked: true };
    const unknown = async () => (held ? { edit: await take(kept), clash: false, checked: false } : undefined);
    if (!this.online) return unknown();
    let verdict: Verdict;
    try {
      verdict = await this.verdict(kept, latest, !!held);
    } catch {
      return unknown();
    }
    if (verdict === "landed") return void (await this.landed(latest.path));
    if (verdict === "send") return { edit: await take(kept), clash: false, checked: true };
    const clash = { ...kept, conflict: true, owner: this.page };
    await this.hold(clash);
    await this.dropDraft(latest.path);
    return { edit: clash, clash: true, checked: true };
  }

  /**
   * A kept edit against the server's latest: "landed" if the server has it (its text, or its id
   * applied), "send" if nothing has changed since its base, and otherwise "clash". Throws offline.
   *
   * A held edit (made offline, ADR 0001) whose id the server doesn't know, from within the time the
   * server keeps ids, never landed: it's sent, to be merged there. One older than that might have
   * landed and been forgotten, so it's a clash. A draft that never landed is a clash too: the page
   * went before it was saved, so it's shown before it's merged.
   */
  async verdict(edit: Unsent, latest: WorkspaceFile, held: boolean): Promise<Verdict> {
    if (edit.text === latest.text) return "landed";
    if (edit.base === latest.revision) return "send";
    if (edit.edit && (await this.net.editApplied(latest.path, edit.edit))) return "landed";
    const known = edit.edit !== undefined && edit.time !== undefined && Date.now() - edit.time < KNOWN_DAYS * 86_400_000;
    return held && known ? "send" : "clash";
  }

  /** A file as the server has it now. Not reaching the server throws, as fetch does. */
  async latest(path: FilePath): Promise<WorkspaceFile> {
    try {
      const file = await this.net.read(path);
      this.reached(true);
      await this.kv.set("files", path, file);
      return file;
    } catch (err) {
      if (unreachable(err)) this.reached(false);
      throw err;
    }
  }

  /**
   * A note was deleted forever: nothing of it stays in this browser. Its kept copy, its draft and an
   * edit held to send all go, so it can't be opened offline, and a held edit can't bring it back. A new
   * note made here at the path meanwhile (based on no revision) isn't it, and stays.
   */
  async forget(path: FilePath): Promise<void> {
    await this.kv.del("files", path);
    await this.forgetPurged(path, async () => true);
  }

  /** A kept edit the server has: held or drafted, it goes. */
  async landed(path: FilePath): Promise<void> {
    await this.release(path);
    await this.dropDraft(path);
  }

  /**
   * This page's edit of a note is no more (saved, undone, reloaded, or the note opened as saved): marked
   * so at once, then what it kept of it goes, wherever it was kept. Another page's edit of the same
   * note, kept in the same place, stays: it's still that page's.
   */
  async letGoOwn(path: FilePath): Promise<void> {
    this.keepCleanNow([path]);
    const held = await this.kv.get<Unsent>("unsent", path);
    if (held && held.owner === this.page) await this.release(path);
    if (!this.account) return;
    if (this.keptAsWent(path)?.owner === this.page)
      try {
        localStorage.removeItem(this.draftKey(path));
      } catch {
        // Not there.
      }
    if ((await this.kv.get<Unsent>("meta", this.draftKey(path)))?.owner === this.page) await this.kv.del("meta", this.draftKey(path));
  }

  /** The note is saved: its kept edit can go. */
  async dropDraft(path: FilePath): Promise<void> {
    try {
      localStorage.removeItem(this.draftKey(path));
    } catch {
      // Nothing kept there.
    }
    await this.kv.del("meta", this.draftKey(path));
  }

  /** Signed out: every account's drafts go, and none is kept again as the page goes. */
  async forgetDrafts(): Promise<void> {
    this.account = null;
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith(DRAFT)) localStorage.removeItem(key);
    } catch {
      // Nothing to forget.
    }
    try {
      for (const key of storedKeys()) if (key.startsWith(CLEAN)) localStorage.removeItem(key);
    } catch {
      // Nothing to forget.
    }
    for (const key of await this.kv.keys("meta")) if (key.startsWith(DRAFT)) await this.kv.del("meta", key);
  }

  /**
   * Send held edits, except those an open editor is sending itself, by keptEdit's rule: one the server
   * has goes, one on the server's latest revision is sent, and one the note has moved on from without
   * it is held as a clash, never merged unseen. One the server can't merge stays, as a clash too.
   */
  async flush(skip: (path: FilePath) => boolean = () => false): Promise<{ sent: FilePath[]; conflicts: FilePath[] }> {
    const sent: FilePath[] = [];
    const conflicts: FilePath[] = [];
    for (const u of await this.unsent()) {
      if (skip(u.path) || u.conflict) continue;
      let result: WriteResult;
      try {
        const latest = await this.latest(u.path);
        const verdict = await this.verdict(u, latest, true);
        result = verdict === "send" ? await this.write(u.path, u.text, u.base, u.edit) : verdict === "landed" ? { status: "saved", file: latest } : { status: "conflict", file: latest };
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
    keys: async (store: Store) => [...s(store).keys()],
  };
}

/**
 * The browser's IndexedDB, as a KV. If IndexedDB isn't there, or won't open (a private window, or
 * storage blocked for this site), a memory store stands in: the app works, keeping nothing past the page.
 */
export function idbKV(name = "common-ink", openTimeout = 4000): KV {
  const memory = memoryKV();
  if (typeof indexedDB === "undefined") return { ...memory, durable: async () => false };
  let db: IDBDatabase | null = null;
  const opened = new Promise<IDBDatabase | null>((resolve) => {
    // An open can wait without end: on another tab of an older version holding the database, say.
    const late = setTimeout(() => resolve(null), openTimeout);
    const done = (result: IDBDatabase | null) => {
      clearTimeout(late);
      resolve(result);
    };
    try {
      // Version 2 adds "ops"; upgrading makes whichever stores are missing.
      const open = indexedDB.open(name, 2);
      open.onupgradeneeded = () => {
        for (const store of ["files", "unsent", "meta", "ops"]) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
      };
      open.onsuccess = () => {
        const result = open.result;
        // Opened after the page gave up on it: memory is what's kept now.
        void opened.then((used) => used !== result && result.close());
        // A newer page needs the database to upgrade it: let it go, and keep to memory from here.
        result.onversionchange = () => {
          result.close();
          db = null;
        };
        db = result;
        done(result);
      };
      open.onerror = () => done(null);
    } catch {
      done(null);
    }
  });
  const run = async <T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, instead: (kv: KV) => Promise<T>): Promise<T> => {
    if (!(await opened) || !db) return instead(memory);
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: <T>(store: Store, key: string) => run<T | undefined>(store, "readonly", (s) => s.get(key), (kv) => kv.get<T>(store, key)),
    set: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key), (kv) => kv.set(store, key, value)),
    del: (store, key) => run(store, "readwrite", (s) => s.delete(key), (kv) => kv.del(store, key)),
    all: <T>(store: Store) => run<T[]>(store, "readonly", (s) => s.getAll(), (kv) => kv.all<T>(store)),
    durable: async () => !!(await opened) && !!db,
    keys: async (store: Store) => (await run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys(), (kv) => kv.keys(store))).map(String),
  };
}
