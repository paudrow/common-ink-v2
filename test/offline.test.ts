import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { ServerAnswer } from "../web/src/api.ts";
import { memoryKV, Offline, type HeldOp, type Network } from "../web/src/offline.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };
const PLAN = "Plan.md" as FilePath;

/** The real files store behind a network that can be cut. */
function setup() {
  const store = memoryStore();
  let up = true;
  const gate = <T>(fn: () => T): Promise<T> => (up ? Promise.resolve(fn()) : Promise.reject(new TypeError("Failed to fetch")));
  const net: Network = {
    list: () => gate(() => store.files.list()),
    read: (path) => gate(() => store.files.read(path) ?? { path, text: "", revision: 0 }),
    write: (path, text, base, edit) => gate(() => store.files.write({ path, text, base, author: you, ...(edit ? { edit } : {}) })),
    editApplied: (path, edit) => gate(() => store.files.editApplied(path, edit)),
  };
  const offline = new Offline(memoryKV(), net);
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

test("an edit held offline is sent on reconnect and merged with what changed meanwhile", async () => {
  const { store, offline, setUp } = setup();
  store.files.write({ path: PLAN, text: "one\ntwo\n", base: 0, author: you });
  setUp(false);
  await assert.rejects(offline.write(PLAN, "one\ntwo\nthree\n", 1), TypeError);
  await offline.hold({ path: PLAN, text: "one\ntwo\nthree\n", base: 1 });
  // Someone else edits another line while this browser is offline.
  store.files.write({ path: PLAN, text: "ONE\ntwo\n", base: 1, author: { kind: "agent", name: "Helper" } });
  assert.deepEqual(await offline.flush(), { sent: [], conflicts: [] }, "still offline: nothing sent, nothing lost");
  assert.equal((await offline.unsent()).length, 1);
  setUp(true);
  assert.deepEqual(await offline.flush(), { sent: [PLAN], conflicts: [] });
  assert.equal(store.files.read(PLAN)?.text, "ONE\ntwo\nthree\n");
  assert.deepEqual(await offline.unsent(), []);
  assert.equal((await offline.read(PLAN)).text, "ONE\ntwo\nthree\n");
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
  assert.deepEqual(await opened(s), { edit: { path: TRIP, text: "# Trip\n- a\n- held\n", base: 1, edit: "h", time: (await s.offline.unsentFor(TRIP))!.time }, clash: false });
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
