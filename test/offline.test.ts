import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { memoryKV, Offline, type Network } from "../web/src/offline.ts";
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
    write: (path, text, base) => gate(() => store.files.write({ path, text, base, author: you })),
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
  const offline = new Offline(kv, { list: async () => [], read: async (path) => ({ path, text: "", revision: 0 }), write: async () => ({ status: "saved", file: { path: "x.md" as never, text: "", revision: 1 } }) });
  await offline.holdOp({ method: "PATCH", body: { address: "event:sample/work/a", title: "A" }, what: "Change A" });
  await offline.holdOp({ method: "DELETE", body: { address: "event:sample/work/gone" }, what: "Delete gone" });
  await offline.holdOp({ method: "POST", body: { title: "C", start: "2026-10-05T09:00" }, what: "Add C" });
  const down = await offline.flushOps(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual([down.sent, (await offline.ops()).length, offline.online], [0, 3, false]);
  const sent: string[] = [];
  const back = await offline.flushOps(async (op) => {
    if (op.method === "DELETE") throw new Error("There's no event at event:sample/work/gone");
    sent.push(op.what);
  });
  assert.deepEqual(sent, ["Change A", "Add C"]);
  assert.deepEqual(back.refused.map((r) => [r.op.what, r.error]), [["Delete gone", "There's no event at event:sample/work/gone"]]);
  assert.deepEqual(await offline.ops(), []);
});
