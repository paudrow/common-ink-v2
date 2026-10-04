import assert from "node:assert/strict";
import { test } from "node:test";
import { patch } from "node-diff3";
import { Docs, parseDocPath, SEED_AUTHOR, type Author, type DocPath, type Seed } from "../worker/src/docs.ts";
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
