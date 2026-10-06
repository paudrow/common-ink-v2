import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { ServerAnswer } from "../web/src/api.ts";
import { idbKV, memoryKV, Offline, type HeldOp, type KV, type Network } from "../web/src/offline.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };
const PLAN = "Plan.md" as FilePath;

/** The real files store behind a network that can be cut. */
function setup(kv: KV = memoryKV()) {
  const store = memoryStore();
  let up = true;
  const gate = <T>(fn: () => T): Promise<T> => (up ? Promise.resolve(fn()) : Promise.reject(new TypeError("Failed to fetch")));
  const net: Network = {
    list: () => gate(() => store.files.list()),
    read: (path) => gate(() => store.files.read(path) ?? { path, text: "", revision: 0 }),
    write: (path, text, base, edit) => gate(() => store.files.write({ path, text, base, author: you, ...(edit ? { edit } : {}) })),
    editApplied: (path, edit) => gate(() => store.files.editApplied(path, edit)),
  };
  const offline = new Offline(kv, net);
  return { store, offline, setUp: (v: boolean) => (up = v) };
}

test("files read while online can be read offline, as last seen", async () => {
  const { store, offline, setUp } = setup();
  store.files.write({ path: PLAN, text: "# Plan\n", base: 0, author: you });
  await offline.list();
  await offline.read(PLAN);
  setUp(false);
  assert.deepEqual(await offline.read(PLAN), { path: PLAN, text: "# Plan\n", revision: 1 });
  assert.deepEqual(await offline.list(), [{ path: PLAN, revision: 1 }]);
  assert.equal(offline.online, false);
  assert.deepEqual(await offline.read("Never seen.md" as FilePath), { path: "Never seen.md", text: "", revision: 0 });
});

test("an edit held offline is sent on reconnect when the note hasn't changed meanwhile", async () => {
  const { store, offline, setUp } = setup();
  store.files.write({ path: PLAN, text: "one\ntwo\n", base: 0, author: you });
  setUp(false);
  await assert.rejects(offline.write(PLAN, "one\ntwo\nthree\n", 1), TypeError);
  await offline.hold({ path: PLAN, text: "one\ntwo\nthree\n", base: 1, edit: "o" });
  assert.deepEqual(await offline.flush(), { sent: [], conflicts: [] }, "still offline: nothing sent, nothing lost");
  assert.equal((await offline.unsent()).length, 1);
  setUp(true);
  assert.deepEqual(await offline.flush(), { sent: [PLAN], conflicts: [] });
  assert.equal(store.files.read(PLAN)?.text, "one\ntwo\nthree\n");
  assert.deepEqual(await offline.unsent(), []);
  assert.equal((await offline.read(PLAN)).text, "one\ntwo\nthree\n");
});

test("an edit held offline is merged on reconnect with what changed meanwhile, since the server never had it", async () => {
  const { store, offline, setUp } = setup();
  store.files.write({ path: PLAN, text: "one\ntwo\n", base: 0, author: you });
  setUp(false);
  await offline.hold({ path: PLAN, text: "one\ntwo\nthree\n", base: 1, edit: "o" });
  store.files.write({ path: PLAN, text: "ONE\ntwo\n", base: 1, author: { kind: "agent", name: "Helper" } });
  setUp(true);
  assert.deepEqual(await offline.flush(), { sent: [PLAN], conflicts: [] });
  assert.equal(store.files.read(PLAN)?.text, "ONE\ntwo\nthree\n");
  assert.deepEqual(await offline.unsent(), []);
});

test("an edit held longer than the server keeps ids, on a note changed since, is a clash: it may have landed and been forgotten", async () => {
  const { store, offline } = setup();
  store.files.write({ path: PLAN, text: "one\ntwo\n", base: 0, author: you });
  await offline.hold({ path: PLAN, text: "one\ntwo\nthree\n", base: 1, edit: "o", time: Date.now() - 31 * 86_400_000 });
  store.files.write({ path: PLAN, text: "ONE\ntwo\n", base: 1, author: { kind: "agent", name: "Helper" } });
  assert.deepEqual(await offline.flush(), { sent: [], conflicts: [PLAN] });
  assert.equal(store.files.read(PLAN)?.text, "ONE\ntwo\n");
});

test("an edit held again as its sends keep failing keeps the time it was first held", async () => {
  const { offline } = setup();
  await offline.hold({ path: PLAN, text: "a\n", base: 1, edit: "o", time: 5 });
  await offline.hold({ path: PLAN, text: "a\n", base: 1, edit: "o" });
  assert.equal((await offline.unsentFor(PLAN))?.time, 5);
  await offline.hold({ path: PLAN, text: "ab\n", base: 1, edit: "p" });
  assert.notEqual((await offline.unsentFor(PLAN))?.time, 5, "a new edit, a new time");
});

test("an unsent edit that clashes with the server's stays, marked, and isn't sent again", async () => {
  const { store, offline } = setup();
  store.files.write({ path: PLAN, text: "one\n", base: 0, author: you });
  store.files.write({ path: PLAN, text: "uno\n", base: 1, author: you });
  await offline.hold({ path: PLAN, text: "ein\n", base: 1 });
  assert.deepEqual(await offline.flush(), { sent: [], conflicts: [PLAN] });
  assert.equal((await offline.unsentFor(PLAN))?.conflict, true);
  assert.deepEqual(await offline.flush(), { sent: [], conflicts: [] });
  assert.equal(store.files.read(PLAN)?.text, "uno\n");
});

test("edits an open editor is sending itself are left to it, and new files show in the list offline", async () => {
  const { offline, setUp } = setup();
  await offline.hold({ path: "New.md" as FilePath, text: "# New\n", base: 0 });
  assert.deepEqual(await offline.flush((p) => p === "New.md"), { sent: [], conflicts: [] });
  setUp(false);
  assert.deepEqual(await offline.list(), [{ path: "New.md", revision: 0 }]);
});

test("warming keeps a copy of every file, so ones never opened still open offline", async () => {
  const { store, offline, setUp } = setup();
  store.files.write({ path: PLAN, text: "# Plan\n", base: 0, author: you });
  store.files.write({ path: "Other.md" as FilePath, text: "# Other\n", base: 0, author: you });
  await offline.warm(await offline.list());
  setUp(false);
  assert.equal((await offline.read("Other.md" as FilePath)).text, "# Other\n");
});

test("edits of records made offline wait in order, go once the server's back, and one it refuses is dropped with why", async () => {
  const kv = memoryKV();
  const offline = new Offline(kv, { list: async () => [], read: async (path) => ({ path, text: "", revision: 0 }), write: async () => ({ status: "saved", file: { path: "x.md" as never, text: "", revision: 1 } }), editApplied: async () => false });
  await offline.holdOp({ method: "PATCH", body: { address: "event:sample/work/a", title: "A" }, what: "Change A" });
  await offline.holdOp({ method: "DELETE", body: { address: "event:sample/work/gone" }, what: "Delete gone" });
  await offline.holdOp({ method: "POST", body: { title: "C", start: "2026-10-05T09:00" }, what: "Add C" });
  const down = await offline.flushOps(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual([down.sent, (await offline.ops()).length, offline.online], [0, 3, false]);
  const sent: string[] = [];
  const back = await offline.flushOps(async (op) => {
    if (op.method === "DELETE") throw new ServerAnswer("There's no event at event:sample/work/gone", 400);
    sent.push(op.what);
  });
  assert.deepEqual(sent, ["Change A", "Add C"]);
  assert.deepEqual(back.refused.map((r) => [r.op.what, r.error]), [["Delete gone", "There's no event at event:sample/work/gone"]]);
  assert.deepEqual(await offline.ops(), []);
});

test("held edits of records go once each, however often sending starts, and wait while the server fails", async () => {
  const offline = new Offline(memoryKV(), { list: async () => [], read: async (path) => ({ path, text: "", revision: 0 }), write: async () => ({ status: "saved", file: { path: "x.md" as never, text: "", revision: 1 } }), editApplied: async () => false });
  await offline.holdOp({ method: "POST", body: { id: "lunch00000000000000000000", title: "Lunch", start: "2026-10-05T12:00" }, what: "Add Lunch" });
  const failing = await offline.flushOps(async () => {
    throw new ServerAnswer("Service Unavailable", 503);
  });
  assert.deepEqual([failing.sent, failing.refused, (await offline.ops()).length], [0, [], 1], "a server that fails keeps the edit");
  const sent: string[] = [];
  const send = async (op: HeldOp) => {
    sent.push(op.what);
    await new Promise((r) => setTimeout(r, 10));
  };
  await Promise.all([offline.flushOps(send), offline.flushOps(send)]);
  assert.deepEqual(sent, ["Add Lunch"]);
  assert.deepEqual(await offline.ops(), []);
});

test("IndexedDB that won't open (storage blocked) leaves a store in memory, so the app still works", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  for (const open of [
    () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    () => {
      const req = { error: new DOMException("Blocked", "UnknownError") } as { error: DOMException; onerror?: () => void };
      setTimeout(() => req.onerror?.());
      return req;
    },
  ]) {
    Object.defineProperty(globalThis, "indexedDB", { value: { open }, configurable: true });
    const kv = idbKV("blocked");
    await kv.set("files", "Plan.md", { text: "a" });
    assert.deepEqual(await kv.get("files", "Plan.md"), { text: "a" });
    assert.deepEqual(await kv.all("files"), [{ text: "a" }]);
    assert.deepEqual(await kv.keys("files"), ["Plan.md"]);
    await kv.del("files", "Plan.md");
    assert.equal(await kv.get("files", "Plan.md"), undefined);
  }
  if (had) Object.defineProperty(globalThis, "indexedDB", had);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

test("IndexedDB that never answers (an older tab holding it) gives way to memory after a moment, and says so", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let late: (() => void) | undefined;
  let closed = false;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const req = { result: { close: () => (closed = true) } } as { result: unknown; onsuccess?: () => void; onblocked?: () => void };
        // Blocked, then answers only long after.
        setTimeout(() => req.onblocked?.());
        late = () => req.onsuccess?.();
        return req;
      },
    },
  });
  const kv = idbKV("hanging", 30);
  await kv.set("files", "Plan.md", { text: "a" });
  assert.deepEqual(await kv.get("files", "Plan.md"), { text: "a" });
  assert.equal(await kv.durable?.(), false, "kept in memory only");
  late!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(closed, true, "a database that opens after the page gave up on it is let go");
  assert.deepEqual(await kv.get("files", "Plan.md"), { text: "a" }, "and memory is still what's kept");
  if (had) Object.defineProperty(globalThis, "indexedDB", had);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

test("a newer page upgrading the database is let have it: this one keeps to memory from then", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const stored = new Map<string, unknown>();
  let closed = false;
  const db = {
    objectStoreNames: { contains: () => true },
    close: () => (closed = true),
    onversionchange: null as null | (() => void),
    transaction() {
      const tx = { oncomplete: null as null | (() => void), onerror: null };
      const request = (result: unknown) => {
        const req = { result };
        setTimeout(() => tx.oncomplete?.());
        return req;
      };
      return Object.assign(tx, { objectStore: () => ({ put: (v: unknown, k: string) => request(stored.set(k, v) && k), get: (k: string) => request(stored.get(k)) }) });
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const req = { result: db } as { result: unknown; onsuccess?: () => void };
        setTimeout(() => req.onsuccess?.());
        return req;
      },
    },
  });
  const kv = idbKV("upgraded", 1000);
  await kv.set("files", "A.md", 1);
  assert.equal(await kv.durable?.(), true);
  assert.equal(stored.get("A.md"), 1);
  db.onversionchange?.();
  assert.equal(closed, true);
  await kv.set("files", "B.md", 2);
  assert.equal(stored.has("B.md"), false, "not written to a database it let go of");
  assert.equal(await kv.get("files", "B.md"), 2);
  assert.equal(await kv.durable?.(), false);
  if (had) Object.defineProperty(globalThis, "indexedDB", had);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

test("back online, one request says whether the server can be reached, with nothing waiting to send", async () => {
  const { offline, setUp } = setup();
  setUp(false);
  await offline.list();
  assert.equal(offline.online, false);
  assert.equal(await offline.check(), false, "the browser says online, the server still can't be reached");
  setUp(true);
  assert.equal(await offline.check(), true);
  assert.equal(offline.online, true);
});

/** A note saved once, opened by a page signed in as you. */
async function kept(text = "# Trip\n- a\n") {
  const s = setup();
  s.offline.account = "you@example.com";
  s.store.files.write({ path: TRIP, text, base: 0, author: you });
  return s;
}
const TRIP = "Trip.md" as FilePath;
const opened = async (s: ReturnType<typeof setup>) => s.offline.keptEdit(await s.offline.read(TRIP));

test("a kept edit based on the note as it is picks up where it left off, to be sent", async () => {
  const s = await kept();
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, edit: "e1" });
  const found = await opened(s);
  assert.equal(found?.clash, false);
  assert.equal(found?.edit.text, "# Trip\n- a\n- packed\n");
});

test("a kept edit the server applied goes, though the note changed since: what was deleted stays deleted", async () => {
  const s = await kept();
  // The page sent it as it went, and never heard back; then its line was deleted elsewhere.
  s.store.files.write({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, author: you, edit: "went" });
  s.store.files.write({ path: TRIP, text: "# Trip\n- a\n", base: 2, author: you });
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, edit: "went" });
  assert.equal(await opened(s), undefined);
  assert.equal(await opened(s), undefined, "and it's gone");
  assert.equal(s.store.files.read(TRIP)?.text, "# Trip\n- a\n");
});

test("a kept edit that never landed, on a note that changed since, is a clash to settle, not merged unseen", async () => {
  const s = await kept();
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, edit: "lost" });
  s.store.files.write({ path: TRIP, text: "# Trip to Rome\n- a\n", base: 1, author: you });
  const found = await opened(s);
  assert.equal(found?.clash, true);
  assert.equal(found?.edit.text, "# Trip\n- a\n- packed\n");
  assert.equal(typeof found?.edit.time, "number", "it says when it was kept");
  // Held as a clash, so the status bar shows it and a reload still has it; the note isn't touched.
  assert.deepEqual((await s.offline.unsent()).map((u) => [u.path, u.conflict]), [[TRIP, true]]);
  assert.equal(s.store.files.read(TRIP)?.text, "# Trip to Rome\n- a\n");
  assert.equal((await opened(s))?.clash, true);
});

test("a kept edit of the server's own text goes", async () => {
  const s = await kept();
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n", base: 0, edit: "x" });
  assert.equal(await opened(s), undefined);
});

test("offline, a kept draft waits unused until the server can say, and a held edit is used as it was", async () => {
  const s = await kept();
  await s.offline.read(TRIP);
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, edit: "d" });
  s.setUp(false);
  assert.equal(await opened(s), undefined);
  s.setUp(true);
  assert.equal((await opened(s))?.edit.edit, "d", "still kept for when it's back");
  await s.offline.hold({ path: TRIP, text: "# Trip\n- a\n- held\n", base: 1, edit: "h" });
  s.setUp(false);
  const found = await opened(s);
  assert.deepEqual([found?.edit.text, found?.edit.edit, found?.clash, found?.checked], ["# Trip\n- a\n- held\n", "h", false, false]);
});

test("a held edit sent twice, the first answer lost, writes once", async () => {
  const s = await kept("one\ntwo\n");
  await s.offline.hold({ path: TRIP, text: "one\ntwo\nthree\n", base: 1, edit: "h" });
  s.store.files.write({ path: TRIP, text: "one\ntwo\nthree\n", base: 1, author: you, edit: "h" });
  s.store.files.write({ path: TRIP, text: "one\ntwo\n", base: 2, author: you });
  assert.deepEqual(await s.offline.flush(), { sent: [TRIP], conflicts: [] });
  assert.equal(s.store.files.read(TRIP)?.text, "one\ntwo\n");
});

test("signing out forgets every kept draft, and none is kept after", async () => {
  const s = await kept();
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- private\n", base: 1, edit: "p" });
  await s.offline.forgetDrafts();
  await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- more private\n", base: 1, edit: "q" });
  s.offline.account = "you@example.com";
  assert.equal(await opened(s), undefined);
});

test("a held edit that landed, for a note not open, isn't sent again by the background flush, though its line was deleted since", async () => {
  const s = await kept("# Trip\n- a\n");
  s.store.files.write({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, author: you, edit: "went" });
  for (let i = 0; i < 60; i++) s.store.files.write({ path: TRIP, text: `# Trip ${i}\n- a\n- packed\n`, base: i + 2, author: you });
  s.store.files.write({ path: TRIP, text: "# Trip\n- a\n", base: 62, author: you });
  await s.offline.hold({ path: TRIP, text: "# Trip\n- a\n- packed\n", base: 1, edit: "went" });
  assert.deepEqual(await s.offline.flush(), { sent: [TRIP], conflicts: [] });
  assert.equal(s.store.files.read(TRIP)?.text, "# Trip\n- a\n");
  assert.deepEqual(await s.offline.unsent(), []);
});

test("a note whose edits were undone as the page went: what was kept of them before isn't sent next time", async () => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } }, configurable: true });
  try {
    const s = await kept();
    await s.offline.keepDraft({ path: TRIP, text: "# Trip\n", base: 1, edit: "dw", time: Date.now() - 100 });
    await s.offline.hold({ path: TRIP, text: "# Trip\n", base: 1, edit: "dw", time: Date.now() - 100 });
    s.offline.keepCleanNow([TRIP]);
    assert.equal(await opened(s), undefined);
    assert.deepEqual(await s.offline.unsent(), [], "the held edit goes too");
    assert.deepEqual([...items.keys()].filter((k) => !k.endsWith(".seq")), [], "and the mark with it");
    // An edit made after the mark (another page, later) is kept as usual.
    s.offline.keepCleanNow([TRIP]);
    await new Promise((r) => setTimeout(r, 5));
    await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- later\n", base: 1, edit: "l" });
    assert.equal((await opened(s))?.edit.text, "# Trip\n- a\n- later\n");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("of a draft kept as the page went and one typed after it came back, the newer is the one", async () => {
  const items = new Map<string, string>();
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    const s = await kept();
    // The page went (kept at once), came back from the browser's back-forward cache, and typing went on.
    s.offline.keepDraftsNow([{ path: TRIP, text: "# Trip\n- a\n- went\n", base: 1, edit: "w" }]);
    const wentKey = [...items.keys()].find((k) => k.startsWith("common-ink.draft:"))!;
    const went = JSON.parse(items.get(wentKey)!) as { time: number };
    items.set(wentKey, JSON.stringify({ ...went, path: TRIP, text: "# Trip\n- a\n- went\n", base: 1, edit: "w", time: Date.now() - 60_000 }));
    await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- went\n- and more\n", base: 1, edit: "t" });
    assert.equal((await opened(s))?.edit.text, "# Trip\n- a\n- went\n- and more\n");
    // And the other way: the page went after the last typing.
    s.offline.keepDraftsNow([{ path: TRIP, text: "# Trip\n- a\n- last\n", base: 1, edit: "l" }]);
    assert.equal((await opened(s))?.edit.text, "# Trip\n- a\n- last\n");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("a clash typed back to the server's own text is no clash when the note opens", async () => {
  const s = await kept();
  s.store.files.write({ path: TRIP, text: "# Trip\n- b\n", base: 1, author: you });
  await s.offline.hold({ path: TRIP, text: "# Trip\n- b\n", base: 1, edit: "c", conflict: true });
  assert.equal(await opened(s), undefined);
  assert.deepEqual(await s.offline.unsent(), []);
});

test("with IndexedDB that never answers, an edit undone is let go of from the memory standing in for it", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => ({}) } });
  try {
    const s = setup(idbKV("hanging-let-go", 30));
    s.offline.account = "you@example.com";
    s.store.files.write({ path: TRIP, text: "# Trip\n- a\n", base: 0, author: you });
    await s.offline.hold({ path: TRIP, text: "# Trip\n- a\n- b\n", base: 1, edit: "b" });
    await s.offline.keepDraft({ path: TRIP, text: "# Trip\n- a\n- b\n", base: 1, edit: "b" });
    assert.deepEqual((await s.offline.unsent()).map((u) => u.text), ["# Trip\n- a\n- b\n"]);
    await s.offline.letGoOwn(TRIP);
    assert.deepEqual(await s.offline.unsent(), [], "the held edit goes");
    assert.equal(await opened(s), undefined, "and the draft: the note opens as saved");
  } finally {
    if (had) Object.defineProperty(globalThis, "indexedDB", had);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  }
});

/** Two pages of the app in one browser, keeping edits in the same place, as two tabs do. */
async function twoPages() {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } }, configurable: true });
  const store = memoryStore();
  const kv = memoryKV();
  const net: Network = {
    list: async () => store.files.list(),
    read: async (path) => store.files.read(path) ?? { path, text: "", revision: 0 },
    write: async (path, text, base, edit) => store.files.write({ path, text, base, author: you, ...(edit ? { edit } : {}) }),
    editApplied: async (path, edit) => store.files.editApplied(path, edit),
  };
  const a = new Offline(kv, net);
  const b = new Offline(kv, net);
  a.account = b.account = "you@example.com";
  store.files.write({ path: TRIP, text: "# Trip\n- a\n", base: 0, author: you });
  return { a, b, store, items, done: () => delete (globalThis as { localStorage?: unknown }).localStorage };
}

test("one page's edit undone doesn't let go of another page's edit of the same note", async () => {
  const { a, b, done } = await twoPages();
  try {
    // B has an edit held offline, and its draft; A edits the same note and undoes it.
    await b.hold({ path: TRIP, text: "# Trip\n- a\n- B's\n", base: 1, edit: "b" });
    await b.keepDraft({ path: TRIP, text: "# Trip\n- a\n- B's\n", base: 1, edit: "b" });
    await a.letGoOwn(TRIP);
    assert.equal((await a.unsentFor(TRIP))?.text, "# Trip\n- a\n- B's\n", "B's held edit stays");
    // As A goes, its mark is about its own edits only.
    a.keepCleanNow([TRIP]);
    b.keepDraftsNow([{ path: TRIP, text: "# Trip\n- a\n- B's\n", base: 1, edit: "b" }]);
    assert.equal((await a.keptEdit((await a.read(TRIP))))?.edit.text, "# Trip\n- a\n- B's\n", "B's edit opens the note");
    // And B lets go of its own.
    await b.letGoOwn(TRIP);
  } finally {
    done();
  }
});

test("what's kept is ordered by a count, not the clock: a clock set back doesn't make a later edit older", async () => {
  const { a, done } = await twoPages();
  const now = Date.now;
  try {
    a.keepCleanNow([TRIP]);
    Date.now = () => now() - 3_600_000;
    await a.keepDraft({ path: TRIP, text: "# Trip\n- a\n- later\n", base: 1, edit: "l" });
    assert.equal((await a.keptEdit(await a.read(TRIP)))?.edit.text, "# Trip\n- a\n- later\n");
  } finally {
    Date.now = now;
    done();
  }
});
