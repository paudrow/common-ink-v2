import assert from "node:assert/strict";
import { test } from "node:test";
import { patch } from "node-diff3";
import { authorKey, Docs, parseDocPath, SEED_AUTHOR, type Author, type DocPath, type Seed } from "../worker/src/docs.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const bot: Author = { kind: "agent", name: "Summarizer" };
const PLAN = "Plan.md" as DocPath;

function workspace() {
  let clock = 1000;
  return new Docs(memoryDb(), () => clock++);
}

test("a new note is saved as its first change, with its author", () => {
  const notes = workspace();
  const result = notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  assert.deepEqual(result, { status: "saved", doc: { path: PLAN, text: "# Plan\n", revision: 1 } });
  assert.deepEqual(notes.read(PLAN), { path: PLAN, text: "# Plan\n", revision: 1 });
  assert.deepEqual(notes.list(), [{ path: PLAN, revision: 1 }]);
  assert.deepEqual(
    notes.history(PLAN).map(({ revision, path, author, base, time }) => ({ revision, path, author, base, time })),
    [{ revision: 1, path: PLAN, author: ada, base: 0, time: 1000 }],
  );
});

test("each write on the latest revision is one more change", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  const result = notes.write({ path: PLAN, text: "# Plan\n\n- Ship it\n", base: 1, author: bot });
  assert.deepEqual(result, { status: "saved", doc: { path: PLAN, text: "# Plan\n\n- Ship it\n", revision: 2 } });
  assert.deepEqual(
    notes.history(PLAN).map((c) => [c.revision, c.base, c.author]),
    [
      [1, 0, ada],
      [2, 1, bot],
    ],
  );
});

test("writing the same text again records nothing", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  assert.deepEqual(notes.write({ path: PLAN, text: "# Plan\n", base: 1, author: ada }), { status: "saved", doc: { path: PLAN, text: "# Plan\n", revision: 1 } });
  assert.equal(notes.history(PLAN).length, 1);
});

test("revisions count changes across the workspace", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "a", base: 0, author: ada });
  const other = notes.write({ path: "Other.md" as DocPath, text: "b", base: 0, author: ada });
  assert.equal(other.doc?.revision, 2);
});

test("a stale write that touches other lines is merged with what changed since", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\nthree\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Plan\n\nONE\ntwo\nthree\n", base: 1, author: bot });
  const result = notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\nTHREE\n", base: 1, author: ada });
  assert.deepEqual(result, { status: "merged", doc: { path: PLAN, text: "# Plan\n\nONE\ntwo\nTHREE\n", revision: 3 } });
  const last = notes.history(PLAN).at(-1)!;
  assert.deepEqual([last.revision, last.base, last.author], [3, 1, ada]);
});

test("a stale write that touches the same lines is rejected with the current note", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n\none\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Plan\n\nuno\n", base: 1, author: bot });
  const result = notes.write({ path: PLAN, text: "# Plan\n\nein\n", base: 1, author: ada });
  assert.deepEqual(result, { status: "conflict", doc: { path: PLAN, text: "# Plan\n\nuno\n", revision: 2 } });
  assert.equal(notes.history(PLAN).length, 2);
});

test("a write based on a revision the note never had is rejected", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  notes.write({ path: "Other.md" as DocPath, text: "# Other\n", base: 0, author: ada });
  assert.equal(notes.write({ path: PLAN, text: "# Mine\n", base: 2, author: ada }).status, "conflict");
  assert.equal(notes.write({ path: PLAN, text: "# Mine\n", base: 99, author: ada }).status, "conflict");
  assert.equal(notes.read(PLAN)?.text, "# Plan\n");
});

test("creating a note that someone else just created is a conflict, not an overwrite", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Their plan\n", base: 0, author: bot });
  assert.deepEqual(notes.write({ path: PLAN, text: "# My plan\n", base: 0, author: ada }), {
    status: "conflict",
    doc: { path: PLAN, text: "# Their plan\n", revision: 1 },
  });
});

test("a note's changes add up to its text", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Plan\n\nONE\ntwo\n", base: 1, author: bot });
  notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\nthree\n", base: 1, author: ada });
  const replayed = notes.history(PLAN).reduce((text, c) => patch(text, c.diff), [""]);
  assert.equal(replayed.join("\n"), notes.read(PLAN)?.text);
  assert.equal(notes.read(PLAN)?.text, "# Plan\n\nONE\ntwo\nthree\n");
});

const first: Seed = {
  id: "a",
  notes: [
    { path: "Welcome.md", text: "# Welcome\n", replace: false },
    { path: "Try this PR.md", text: "# Try this PR (#1)\n", replace: true },
  ],
};

test("a seed adds its notes as changes by the Preview seed", () => {
  const notes = workspace();
  notes.seed(first);
  assert.deepEqual(notes.list(), [
    { path: "Try this PR.md", revision: 2 },
    { path: "Welcome.md", revision: 1 },
  ]);
  assert.deepEqual(notes.history("Welcome.md" as DocPath)[0].author, SEED_AUTHOR);
});

test("a new seed adds missing notes and rewrites only the ones it replaces", () => {
  const notes = workspace();
  notes.seed(first);
  notes.write({ path: "Welcome.md" as DocPath, text: "# Welcome\n\nEdited.\n", base: 1, author: ada });
  notes.seed({
    id: "b",
    notes: [
      { path: "Welcome.md", text: "# Welcome, again\n", replace: false },
      { path: "Ideas.md", text: "# Ideas\n", replace: false },
      { path: "Try this PR.md", text: "# Try this PR (#2)\n", replace: true },
    ],
  });
  assert.equal(notes.read("Welcome.md" as DocPath)?.text, "# Welcome\n\nEdited.\n");
  assert.equal(notes.read("Ideas.md" as DocPath)?.text, "# Ideas\n");
  assert.equal(notes.read("Try this PR.md" as DocPath)?.text, "# Try this PR (#2)\n");
});

test("the same seed again changes nothing", () => {
  const notes = workspace();
  notes.seed(first);
  const path = "Try this PR.md" as DocPath;
  notes.write({ path, text: "# Mine now\n", base: 2, author: ada });
  notes.seed(first);
  assert.equal(notes.read(path)?.text, "# Mine now\n");
});

test("doc paths are relative markdown or JSON paths", () => {
  for (const ok of ["Plan.md", "Projects/Q4 plan.md", "Try this PR.md", ".common-ink/layout.json"]) assert.equal(parseDocPath(ok), ok);
  for (const bad of ["", "Plan", "Plan.txt", "/Plan.md", "a//b.md", "../Plan.md", "a/./b.md", " Plan.md", "a\\b.md", "a\nb.md", 7, null, `${"x".repeat(300)}.md`]) {
    assert.equal(parseDocPath(bad), null, String(bad));
  }
});

test("a database from the first deploy, with a notes table, keeps its notes and history", () => {
  const db = memoryDb();
  db.run("CREATE TABLE notes(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
  db.run("CREATE TABLE changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)");
  db.run("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO notes VALUES ('Plan.md', '# Plan', 1)");
  db.run(`INSERT INTO changes(path, author, base, diff, time) VALUES ('Plan.md', '{"kind":"user","email":"a@b.c"}', 0, '[]', 1)`);
  const docs = new Docs(db);
  assert.deepEqual(docs.read(PLAN), { path: PLAN, text: "# Plan", revision: 1 });
  assert.equal(docs.write({ path: PLAN, text: "# Plan\n", base: 1, author: ada }).doc?.revision, 2);
  new Docs(db);
  assert.equal(docs.history(PLAN).length, 2);
});

test("undoing a change merges its reverse into the doc as it is now, keeping later edits", () => {
  const docs = workspace();
  docs.write({ path: PLAN, text: "one\ntwo\nthree\n", base: 0, author: ada });
  docs.write({ path: PLAN, text: "one\nTWO\nthree\n", base: 1, author: bot });
  docs.write({ path: PLAN, text: "one\nTWO\nthree\nfour\n", base: 2, author: ada });
  const [result] = docs.undo([2], ada);
  assert.equal(result.status, "undone");
  assert.equal(docs.read(PLAN)?.text, "one\ntwo\nthree\nfour\n");
  const last = docs.history(PLAN).at(-1)!;
  assert.deepEqual([last.revision, last.author, last.undoes], [4, ada, 2]);
});

test("undoing an undo is a redo, and undoing twice changes nothing more", () => {
  const docs = workspace();
  docs.write({ path: PLAN, text: "a\n", base: 0, author: ada });
  docs.write({ path: PLAN, text: "a\nb\n", base: 1, author: bot });
  docs.undo([2], ada);
  assert.equal(docs.recent().find((c) => c.revision === 2)?.undoneBy, 3);
  assert.equal(docs.undo([2], ada)[0].status, "unchanged");
  docs.undo([3], ada);
  assert.equal(docs.read(PLAN)?.text, "a\nb\n");
  assert.equal(docs.recent().find((c) => c.revision === 2)?.undoneBy, null);
  assert.equal(docs.recent().find((c) => c.revision === 3)?.undoneBy, 4);
});

test("an undo that would clash with a later edit to the same lines does nothing", () => {
  const docs = workspace();
  docs.write({ path: PLAN, text: "one\n", base: 0, author: ada });
  docs.write({ path: PLAN, text: "uno\n", base: 1, author: bot });
  docs.write({ path: PLAN, text: "ein\n", base: 2, author: ada });
  assert.equal(docs.undo([2], ada)[0].status, "conflict");
  assert.equal(docs.undo([99], ada)[0].status, "missing");
  assert.equal(docs.read(PLAN)?.text, "ein\n");
});

test("undoing everything an agent did, newest first, across docs", () => {
  const docs = workspace();
  const other = "Other.md" as DocPath;
  docs.write({ path: PLAN, text: "mine\n", base: 0, author: ada });
  docs.write({ path: PLAN, text: "mine\nagent 1\n", base: 1, author: bot });
  docs.write({ path: other, text: "agent 2\n", base: 0, author: bot });
  docs.write({ path: PLAN, text: "mine\nagent 1\nagent 3\n", base: 2, author: bot });
  const byBot = docs.recent({ author: authorKey(bot) }).map((c) => c.revision);
  assert.deepEqual(byBot, [4, 3, 2]);
  const results = docs.undo(byBot, ada);
  assert.deepEqual(
    results.map((r) => r.status),
    ["undone", "undone", "undone"],
  );
  assert.equal(docs.read(PLAN)?.text, "mine\n");
  assert.equal(docs.read(other)?.text, "");
});

test("recent lists changes newest first, by doc, and pages with before", () => {
  const docs = workspace();
  docs.write({ path: PLAN, text: "1", base: 0, author: ada });
  docs.write({ path: "Other.md" as DocPath, text: "2", base: 0, author: ada });
  docs.write({ path: PLAN, text: "3", base: 1, author: ada });
  assert.deepEqual(
    docs.recent().map((c) => c.revision),
    [3, 2, 1],
  );
  assert.deepEqual(
    docs.recent({ path: PLAN }).map((c) => c.revision),
    [3, 1],
  );
  assert.deepEqual(
    docs.recent({ before: 3, limit: 1 }).map((c) => c.revision),
    [2],
  );
});

test("a seed's agent edits apply to notes it just added, as changes by those agents", () => {
  const docs = workspace();
  const seed: Seed = {
    id: "e",
    notes: [{ path: "Garden.md", text: "a\n", replace: false }],
    edits: [{ path: "Garden.md", text: "a\nb\n", agent: "Gardener" }],
  };
  docs.seed(seed);
  const path = "Garden.md" as DocPath;
  assert.equal(docs.read(path)?.text, "a\nb\n");
  assert.deepEqual(docs.history(path).map((c) => c.author), [SEED_AUTHOR, { kind: "agent", name: "Gardener" }]);
  docs.seed({ ...seed, id: "f" });
  assert.equal(docs.history(path).length, 2);
});
