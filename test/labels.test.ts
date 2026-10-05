import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { LABELS_PATH, parseLabels } from "../worker/src/labels.ts";
import { runOperation } from "../worker/src/operations.ts";
import { Files } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

const you: Author = { kind: "user", email: "you@example.com" };
const PLAN = "Plan.md" as FilePath;

test("a label names a note's state now, is a change by its author, and reads back", async () => {
  const store = new Files(memoryDb());
  store.write({ path: PLAN, text: "draft\n", base: 0, author: you });
  const added = await runOperation("add_label", { path: PLAN, name: "First draft" }, store, you);
  assert.deepEqual(added, { ok: true, value: { name: "First draft", path: PLAN, revision: 1 } });
  store.write({ path: PLAN, text: "draft 2\n", base: 1, author: you });
  assert.deepEqual(await runOperation("labels", { path: PLAN }, store, you), { ok: true, value: [{ name: "First draft", path: PLAN, revision: 1 }] });
  assert.deepEqual(store.history(LABELS_PATH).map((c) => c.author), [you]);
  const at = await runOperation("read_version", { path: PLAN, revision: 1 }, store, you);
  assert.deepEqual(at, { ok: true, value: { path: PLAN, revision: 1, text: "draft\n" } });
});

test("labelling the same name again moves it; a note with nothing saved can't be labelled", async () => {
  const store = new Files(memoryDb());
  store.write({ path: PLAN, text: "a\n", base: 0, author: you });
  await runOperation("add_label", { path: PLAN, name: "v1" }, store, you);
  store.write({ path: PLAN, text: "b\n", base: 1, author: you });
  await runOperation("add_label", { path: PLAN, name: "v1" }, store, you);
  assert.deepEqual(parseLabels(store.read(LABELS_PATH)!.text), [{ name: "v1", path: PLAN, revision: 3 }]);
  assert.deepEqual(await runOperation("add_label", { path: "Nope.md", name: "x" }, store, you), { ok: false, error: "Nope.md has no saved version to label yet" });
});

test("a malformed labels file reads as no labels instead of failing", () => {
  assert.deepEqual(parseLabels("{oops"), []);
  assert.deepEqual(parseLabels('{"labels": [{"name": "", "path": "A.md", "revision": 1}, {"name": "ok", "path": "A.md", "revision": 2}]}'), [{ name: "ok", path: "A.md", revision: 2 }]);
});
