import assert from "node:assert/strict";
import { test } from "node:test";
import { Notes, type Seed } from "../worker/src/notes.ts";
import { memoryDb } from "./sqlite.ts";

const text = (db: ReturnType<typeof memoryDb>, path: string) => db.all<{ text: string }>("SELECT text FROM notes WHERE path = ?", path)[0]?.text;

const first: Seed = {
  id: "a",
  notes: [
    { path: "Welcome.md", text: "# Welcome\n", replace: false },
    { path: "Try this PR.md", text: "# Try this PR (#1)\n", replace: true },
  ],
};

test("a seed adds its notes", () => {
  const db = memoryDb();
  const notes = new Notes(db);
  notes.seed(first);
  assert.deepEqual(notes.list(), [{ path: "Try this PR.md" }, { path: "Welcome.md" }]);
});

test("a new seed adds missing notes and rewrites only the ones it replaces", () => {
  const db = memoryDb();
  const notes = new Notes(db);
  notes.seed(first);
  db.run("UPDATE notes SET text = ? WHERE path = ?", "# Welcome\n\nEdited.\n", "Welcome.md");
  notes.seed({
    id: "b",
    notes: [
      { path: "Welcome.md", text: "# Welcome, again\n", replace: false },
      { path: "Ideas.md", text: "# Ideas\n", replace: false },
      { path: "Try this PR.md", text: "# Try this PR (#2)\n", replace: true },
    ],
  });
  assert.equal(text(db, "Welcome.md"), "# Welcome\n\nEdited.\n");
  assert.equal(text(db, "Ideas.md"), "# Ideas\n");
  assert.equal(text(db, "Try this PR.md"), "# Try this PR (#2)\n");
});

test("the same seed again changes nothing", () => {
  const db = memoryDb();
  const notes = new Notes(db);
  notes.seed(first);
  db.run("UPDATE notes SET text = ? WHERE path = ?", "# Mine now\n", "Try this PR.md");
  notes.seed(first);
  assert.equal(text(db, "Try this PR.md"), "# Mine now\n");
});
