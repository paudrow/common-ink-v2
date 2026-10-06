import assert from "node:assert/strict";
import { test } from "node:test";
import { patch } from "node-diff3";
import { authorKey, Files, parseFilePath, SEED_AUTHOR, type Author, type Db, type FilePath, type Seed } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const bot: Author = { kind: "agent", name: "Summarizer" };
const PLAN = "Plan.md" as FilePath;

function workspace() {
  let clock = 1000;
  return new Files(memoryDb(), () => clock++);
}

test("a new note is saved as its first change, with its author", () => {
  const notes = workspace();
  const result = notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  assert.deepEqual(result, { status: "saved", file: { path: PLAN, text: "# Plan\n", revision: 1 } });
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
  assert.deepEqual(result, { status: "saved", file: { path: PLAN, text: "# Plan\n\n- Ship it\n", revision: 2 } });
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
  assert.deepEqual(notes.write({ path: PLAN, text: "# Plan\n", base: 1, author: ada }), { status: "saved", file: { path: PLAN, text: "# Plan\n", revision: 1 } });
  assert.equal(notes.history(PLAN).length, 1);
});

test("revisions count changes across the workspace", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "a", base: 0, author: ada });
  const other = notes.write({ path: "Other.md" as FilePath, text: "b", base: 0, author: ada });
  assert.equal(other.file?.revision, 2);
});

test("a stale write that touches other lines is merged with what changed since", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\nthree\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Plan\n\nONE\ntwo\nthree\n", base: 1, author: bot });
  const result = notes.write({ path: PLAN, text: "# Plan\n\none\ntwo\nTHREE\n", base: 1, author: ada });
  assert.deepEqual(result, { status: "merged", file: { path: PLAN, text: "# Plan\n\nONE\ntwo\nTHREE\n", revision: 3 } });
  const last = notes.history(PLAN).at(-1)!;
  assert.deepEqual([last.revision, last.base, last.author], [3, 1, ada]);
});

test("a stale write that touches the same lines is rejected with the current note", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n\none\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Plan\n\nuno\n", base: 1, author: bot });
  const result = notes.write({ path: PLAN, text: "# Plan\n\nein\n", base: 1, author: ada });
  assert.deepEqual(result, { status: "conflict", file: { path: PLAN, text: "# Plan\n\nuno\n", revision: 2 } });
  assert.equal(notes.history(PLAN).length, 2);
});

test("a write based on a revision the note never had is rejected", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  notes.write({ path: "Other.md" as FilePath, text: "# Other\n", base: 0, author: ada });
  assert.equal(notes.write({ path: PLAN, text: "# Mine\n", base: 2, author: ada }).status, "conflict");
  assert.equal(notes.write({ path: PLAN, text: "# Mine\n", base: 99, author: ada }).status, "conflict");
  assert.equal(notes.read(PLAN)?.text, "# Plan\n");
});

test("creating a note that someone else just created is a conflict, not an overwrite", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Their plan\n", base: 0, author: bot });
  assert.deepEqual(notes.write({ path: PLAN, text: "# My plan\n", base: 0, author: ada }), {
    status: "conflict",
    file: { path: PLAN, text: "# Their plan\n", revision: 1 },
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
  assert.deepEqual(notes.history("Welcome.md" as FilePath)[0].author, SEED_AUTHOR);
});

test("a new seed adds missing notes, keeps your edits to unchanged demos, and rewrites the ones it replaces or that changed", () => {
  const notes = workspace();
  notes.seed({ ...first, notes: [...first.notes, { path: "Tour.md", text: "```tasks\n```\n", replace: false }] });
  notes.write({ path: "Welcome.md" as FilePath, text: "# Welcome\n\nEdited.\n", base: 1, author: ada });
  notes.write({ path: "Tour.md" as FilePath, text: "```tasks\n```\n\nEdited too.\n", base: notes.read("Tour.md" as FilePath)!.revision, author: ada });
  notes.seed({
    id: "b",
    notes: [
      { path: "Welcome.md", text: "# Welcome\n", replace: false },
      { path: "Tour.md", text: "::tasks\n", replace: false },
      { path: "Ideas.md", text: "# Ideas\n", replace: false },
      { path: "Try this PR.md", text: "# Try this PR (#2)\n", replace: true },
    ],
  });
  assert.equal(notes.read("Welcome.md" as FilePath)?.text, "# Welcome\n\nEdited.\n", "the demo didn't change: your edit stays");
  assert.equal(notes.read("Tour.md" as FilePath)?.text, "::tasks\n", "the demo changed: it shows as it is now");
  assert.deepEqual(
    notes.history("Tour.md" as FilePath).map((c) => c.author.kind),
    ["agent", "user", "agent"],
    "and your version is in history, between the two demos",
  );
  assert.equal(notes.read("Ideas.md" as FilePath)?.text, "# Ideas\n");
  assert.equal(notes.read("Try this PR.md" as FilePath)?.text, "# Try this PR (#2)\n");
});

test("a new seed updates the sample notes no one has changed since the last one", () => {
  const notes = workspace();
  notes.seed(first);
  notes.seed({ id: "b", notes: [{ path: "Welcome.md", text: "# Welcome, updated\n", replace: false }] });
  assert.equal(notes.read("Welcome.md" as FilePath)?.text, "# Welcome, updated\n");
  assert.deepEqual(notes.history("Welcome.md" as FilePath)[0].author, SEED_AUTHOR);
});

test("the same seed again changes nothing", () => {
  const notes = workspace();
  notes.seed(first);
  const path = "Try this PR.md" as FilePath;
  notes.write({ path, text: "# Mine now\n", base: 2, author: ada });
  notes.seed(first);
  assert.equal(notes.read(path)?.text, "# Mine now\n");
});

test("file paths are relative markdown or JSON paths", () => {
  for (const ok of ["Plan.md", "Projects/Q4 plan.md", "Try this PR.md", ".common-ink/layout.json"]) assert.equal(parseFilePath(ok), ok);
  for (const bad of ["", "Plan", "Plan.txt", "/Plan.md", "a//b.md", "../Plan.md", "a/./b.md", " Plan.md", "a\\b.md", "a\nb.md", 7, null, `${"x".repeat(300)}.md`]) {
    assert.equal(parseFilePath(bad), null, String(bad));
  }
});

test("a database from the first deploy, with a notes table, keeps its notes and history", () => {
  const db = memoryDb();
  db.run("CREATE TABLE notes(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
  db.run("CREATE TABLE changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)");
  db.run("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO notes VALUES ('Plan.md', '# Plan', 1)");
  db.run(`INSERT INTO changes(path, author, base, diff, time) VALUES ('Plan.md', '{"kind":"user","email":"a@b.c"}', 0, '[]', 1)`);
  const files = new Files(db);
  assert.deepEqual(files.read(PLAN), { path: PLAN, text: "# Plan", revision: 1 });
  assert.equal(files.write({ path: PLAN, text: "# Plan\n", base: 1, author: ada }).file?.revision, 2);
  new Files(db);
  assert.equal(files.history(PLAN).length, 2);
});

test("undoing a change merges its reverse into the file as it is now, keeping later edits", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "one\ntwo\nthree\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "one\nTWO\nthree\n", base: 1, author: bot });
  files.write({ path: PLAN, text: "one\nTWO\nthree\nfour\n", base: 2, author: ada });
  const [result] = files.undo([2], ada);
  assert.equal(result.status, "undone");
  assert.equal(files.read(PLAN)?.text, "one\ntwo\nthree\nfour\n");
  const last = files.history(PLAN).at(-1)!;
  assert.deepEqual([last.revision, last.author, last.undoes], [4, ada, 2]);
});

test("undoing an undo is a redo, and undoing twice changes nothing more", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "a\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "a\nb\n", base: 1, author: bot });
  files.undo([2], ada);
  assert.equal(files.recent().find((c) => c.revision === 2)?.undoneBy, 3);
  assert.equal(files.undo([2], ada)[0].status, "unchanged");
  files.undo([3], ada);
  assert.equal(files.read(PLAN)?.text, "a\nb\n");
  assert.equal(files.recent().find((c) => c.revision === 2)?.undoneBy, null);
  assert.equal(files.recent().find((c) => c.revision === 3)?.undoneBy, 4);
});

test("an undo that would clash with a later edit to the same lines does nothing", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "one\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "uno\n", base: 1, author: bot });
  files.write({ path: PLAN, text: "ein\n", base: 2, author: ada });
  assert.equal(files.undo([2], ada)[0].status, "conflict");
  assert.equal(files.undo([99], ada)[0].status, "missing");
  assert.equal(files.read(PLAN)?.text, "ein\n");
});

test("undoing everything an agent did, newest first, across files", () => {
  const files = workspace();
  const other = "Other.md" as FilePath;
  files.write({ path: PLAN, text: "mine\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "mine\nagent 1\n", base: 1, author: bot });
  files.write({ path: other, text: "agent 2\n", base: 0, author: bot });
  files.write({ path: PLAN, text: "mine\nagent 1\nagent 3\n", base: 2, author: bot });
  const byBot = files.recent({ author: authorKey(bot) }).map((c) => c.revision);
  assert.deepEqual(byBot, [4, 3, 2]);
  const results = files.undo(byBot, ada);
  assert.deepEqual(
    results.map((r) => r.status),
    ["undone", "undone", "undone"],
  );
  assert.equal(files.read(PLAN)?.text, "mine\n");
  assert.equal(files.read(other)?.text, "");
});

test("recent lists changes newest first, by file, and pages with before", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "1", base: 0, author: ada });
  files.write({ path: "Other.md" as FilePath, text: "2", base: 0, author: ada });
  files.write({ path: PLAN, text: "3", base: 1, author: ada });
  assert.deepEqual(
    files.recent().map((c) => c.revision),
    [3, 2, 1],
  );
  assert.deepEqual(
    files.recent({ path: PLAN }).map((c) => c.revision),
    [3, 1],
  );
  assert.deepEqual(
    files.recent({ before: 3, limit: 1 }).map((c) => c.revision),
    [2],
  );
});

test("a seed's agent edits apply to notes it just added, as changes by those agents", () => {
  const files = workspace();
  const seed: Seed = {
    id: "e",
    notes: [{ path: "Garden.md", text: "a\n", replace: false }],
    edits: [{ path: "Garden.md", text: "a\nb\n", agent: "Gardener" }],
  };
  files.seed(seed);
  const path = "Garden.md" as FilePath;
  assert.equal(files.read(path)?.text, "a\nb\n");
  assert.deepEqual(files.history(path).map((c) => c.author), [SEED_AUTHOR, { kind: "agent", name: "Gardener" }]);
  files.seed({ ...seed, id: "f" });
  assert.equal(files.history(path).length, 2);
});

test("a Preview database from before the File rename (a docs table, schema 1) keeps its files", () => {
  const db = memoryDb();
  db.run("CREATE TABLE docs(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
  db.run("CREATE TABLE changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)");
  db.run("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta VALUES ('schema', '1')");
  db.run("INSERT INTO docs VALUES ('Plan.md', '# Plan', 1)");
  const files = new Files(db);
  assert.deepEqual(files.read(PLAN), { path: PLAN, text: "# Plan", revision: 1 });
  assert.deepEqual(files.list(), [{ path: PLAN, revision: 1 }]);
});

test("starting twice, or from an empty database, ends in the same shape", () => {
  const db = memoryDb();
  new Files(db);
  const tables = () => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
  const first = tables();
  new Files(db);
  assert.deepEqual(tables(), first);
  assert.deepEqual(first, ["changes", "connections", "edits", "files", "meta"]);
});

test("a Preview database with an undo column already, and no record of it, starts fine", () => {
  const db = memoryDb();
  new Files(db);
  db.run("DELETE FROM meta");
  const files = new Files(db);
  assert.deepEqual(files.write({ path: PLAN, text: "a", base: 0, author: ada }).file?.revision, 1);
  assert.equal(files.undo([1], ada)[0].status, "undone");
});

test("chosen changes show together, and a change left out splits them into runs without its edits", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "a\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "a\nb\n", base: 1, author: bot });
  files.write({ path: PLAN, text: "a\nb\nc\n", base: 2, author: ada });
  files.write({ path: PLAN, text: "a\nb\nc\nd\n", base: 3, author: bot });
  files.write({ path: "Other.md" as FilePath, text: "x\n", base: 0, author: bot });
  assert.deepEqual(files.combined([2, 3]), [{ path: PLAN, runs: [{ revisions: [2, 3], before: "a\n", after: "a\nb\nc\n" }] }]);
  assert.deepEqual(files.combined([2, 4, 5]), [
    { path: "Other.md", runs: [{ revisions: [5], before: "", after: "x\n" }] },
    {
      path: PLAN,
      runs: [
        { revisions: [2], before: "a\n", after: "a\nb\n" },
        { revisions: [4], before: "a\nb\nc\n", after: "a\nb\nc\nd\n" },
      ],
    },
  ]);
});

test("a file can be read at any of its revisions, and restored to one as a new change that can be undone", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "first\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "second\n", base: 1, author: bot });
  assert.equal(files.versionAt(PLAN, 1), "first\n");
  assert.equal(files.versionAt(PLAN, 99), null);
  const restored = files.restore(PLAN, { revision: 1 }, ada);
  assert.deepEqual(restored, { status: "saved", file: { path: PLAN, text: "first\n", revision: 3 } });
  files.undo([3], ada);
  assert.equal(files.read(PLAN)?.text, "second\n", "nothing is lost");
  files.restore(PLAN, { before: 2 }, ada);
  assert.equal(files.read(PLAN)?.text, "first\n", "before a change is the version just before it");
  files.restore(PLAN, { before: 1 }, ada);
  assert.equal(files.read(PLAN)?.text, "", "before the first change, the file was empty");
});

test("a seed edit can carry a label, which lands in the labels file at that edit's revision", () => {
  const files = workspace();
  files.seed({
    id: "l",
    notes: [{ path: "Garden.md", text: "a\n", replace: false }],
    edits: [
      { path: "Garden.md", text: "a\nb\n", agent: "Gardener", label: "Spring" },
      { path: "Garden.md", text: "a\nb\nc\n", agent: "Gardener" },
    ],
  });
  assert.deepEqual(JSON.parse(files.read(".common-ink/labels.json" as FilePath)!.text), { labels: [{ name: "Spring", path: "Garden.md", revision: 2 }] });
});

test("deleting a file is a change that undo takes back", () => {
  const files = workspace();
  files.write({ path: PLAN, text: "# Plan\n\nShip it.\n", base: 0, author: ada });
  const stale = files.write({ path: PLAN, text: "# Plan\n\nShip it.\nToday.\n", base: 1, author: bot });
  assert.equal(files.write({ path: PLAN, text: "", base: 1, author: ada, delete: true }).status, "conflict", "a delete of an old revision does nothing");
  const deleted = files.write({ path: PLAN, text: "", base: stale.file!.revision, author: ada, delete: true });
  assert.equal(deleted.status, "saved");
  assert.equal(files.read(PLAN), null);
  assert.deepEqual(files.list(), []);
  const [change] = files.recent({ path: PLAN, limit: 1 });
  assert.equal(change.deleted, true);
  assert.equal(files.recent({ path: PLAN }).filter((c) => c.deleted).length, 1, "only the delete says so");
  assert.equal(files.versionAt(PLAN, stale.file!.revision), "# Plan\n\nShip it.\nToday.\n");
  const [undone] = files.undo([change.revision], ada);
  assert.equal(undone.status, "undone");
  assert.equal(files.read(PLAN)!.text, "# Plan\n\nShip it.\nToday.\n");
  assert.equal(files.write({ path: "Gone.md" as FilePath, text: "", base: 1, author: ada, delete: true }).status, "conflict", "nothing to delete");
});

test("JavaScript is a file only as a workspace extension's code", () => {
  assert.ok(parseFilePath(".common-ink/extensions/reading-time/index.js"));
  assert.ok(parseFilePath(".common-ink/extensions/reading-time/lib/model.js"), "any file in its folder");
  assert.equal(parseFilePath("notes/script.js"), null);
  assert.equal(parseFilePath(".common-ink/plugins/reading-time/index.js"), null);
  assert.equal(parseFilePath(".common-ink/extensions/../index.js"), null);
  assert.equal(parseFilePath(".common-ink/extensions/reading-time/../../x.js"), null);
});

test("the last revision given stays the last, even once its changes are gone, as a reset leaves them", () => {
  const db = memoryDb();
  const files = new Files(db);
  files.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  files.write({ path: PLAN, text: "# Plan\n\nMore\n", base: 1, author: ada });
  db.run("DELETE FROM changes");
  assert.equal(files.lastRevision(), 2);
  assert.equal(new Files(memoryDb()).lastRevision(), 0);
});

test("history filtered by author finds its changes far back in a long history, newest first, and pages with before", () => {
  const files = new Files(memoryDb());
  const agent: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };
  const byAgent: number[] = [];
  for (let i = 1; i <= 2500; i++) {
    const result = files.write({ path: "Log.md" as FilePath, text: `${i}\n`, base: files.read("Log.md" as FilePath)?.revision ?? 0, author: i % 900 === 0 ? agent : ada });
    if (i % 900 === 0) byAgent.push(result.status === "conflict" ? -1 : result.file.revision);
  }
  assert.deepEqual(byAgent, [900, 1800]);
  const found = files.recent({ author: "agent:Claude:ada@example.com", limit: 5 });
  assert.deepEqual(found.map((c) => c.revision), [1800, 900]);
  assert.deepEqual(found.map((c) => authorKey(c.author)), ["agent:Claude:ada@example.com", "agent:Claude:ada@example.com"]);
  assert.deepEqual(files.recent({ author: "agent:Claude:ada@example.com", before: 1800 }).map((c) => c.revision), [900]);
  assert.deepEqual(files.recent({ path: "Log.md" as FilePath, limit: 3, before: 1001 }).map((c) => c.revision), [1000, 999, 998]);
});

test("history and diffs of more than a hundred changes at once work within a Durable Object's 100-parameter limit", () => {
  const files = new Files(memoryDb());
  const revisions: number[] = [];
  for (let i = 1; i <= 150; i++) {
    const result = files.write({ path: "Log.md" as FilePath, text: `${i}\n`, base: files.read("Log.md" as FilePath)?.revision ?? 0, author: ada });
    if (result.status !== "conflict") revisions.push(result.file.revision);
  }
  assert.deepEqual(files.recent({ limit: 120 }).map((c) => c.revision), revisions.slice(-120).reverse());
  assert.deepEqual(files.recent({ path: "Log.md" as FilePath, author: "user:ada@example.com", limit: 101 }).length, 101);
  const [diff] = files.combined(revisions);
  assert.deepEqual([diff.path, diff.runs.length, diff.runs[0].before, diff.runs[0].after], ["Log.md", 1, "", "150\n"]);
});

test("open pages hear of changes only once they're kept: a write rolled back announces nothing", () => {
  const heard: number[] = [];
  const files = new Files(memoryDb(), Date.now, (n) => heard.push(n.revision));
  files.write({ path: PLAN, text: "# Plan\n", base: 0, author: ada });
  assert.throws(() => files.seed({ id: "s", notes: [{ path: "Good.md", text: "# Good\n", replace: false }, { path: "../Bad.md", text: "", replace: false }] }));
  assert.equal(files.read("Good.md" as FilePath), null, "the seed was rolled back");
  const next = files.write({ path: PLAN, text: "# Plan\n\nMore\n", base: 1, author: ada });
  assert.deepEqual(heard, [1, next.file!.revision]);
});

/** An in-memory database whose transactions nest with savepoints, as a Durable Object's transactionSync does. */
function nestingDb(): Db {
  const db = memoryDb();
  let depth = 0;
  return {
    ...db,
    tx: (fn) => {
      const point = `p${depth++}`;
      db.raw.exec(`SAVEPOINT ${point}`);
      try {
        const out = fn();
        db.raw.exec(`RELEASE ${point}`);
        return out;
      } catch (err) {
        db.raw.exec(`ROLLBACK TO ${point}`);
        db.raw.exec(`RELEASE ${point}`);
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

test("a transaction inside another announces its changes with the outer one's, once it commits", () => {
  const heard: string[] = [];
  const db = nestingDb();
  const files = new Files(db, Date.now, (n) => heard.push(`${n.path}${(db as ReturnType<typeof memoryDb>).raw?.isTransaction ? " (before commit)" : ""}`));
  files.writeAll([{ path: "Outer.md" as FilePath, text: "o\n", base: 0, author: ada }], () => {
    files.write({ path: "Inner.md" as FilePath, text: "i\n", base: 0, author: ada });
  });
  assert.deepEqual(heard, ["Outer.md", "Inner.md"]);
});

test("one inside another that fails takes the outer one with it, even if the outer one catches the error: none of it is kept or heard", () => {
  const heard: string[] = [];
  const files = new Files(memoryDb(), Date.now, (n) => heard.push(n.path));
  assert.throws(() =>
    files.writeAll([{ path: "Outer.md" as FilePath, text: "o\n", base: 0, author: ada }], () => {
      files.write({ path: "Inner.md" as FilePath, text: "i\n", base: 0, author: ada });
      assert.throws(() => files.seed({ id: "s", notes: [{ path: "Gone.md", text: "g\n", replace: false }, { path: "../Bad.md", text: "", replace: false }] }));
    }),
  );
  assert.deepEqual([heard, files.list()], [[], []]);
  files.write({ path: "After.md" as FilePath, text: "a\n", base: 0, author: ada });
  assert.deepEqual(heard, ["After.md"], "the next transaction is its own");
});

test("a page whose announcement fails doesn't keep the others from hearing", () => {
  const heard: string[] = [];
  const files = new Files(memoryDb(), Date.now, (n) => {
    if (n.path === "A.md") throw new Error("socket gone");
    heard.push(n.path);
  });
  const log = console.error;
  console.error = () => {};
  try {
    files.writeAll([
      { path: "A.md" as FilePath, text: "a\n", base: 0, author: ada },
      { path: "B.md" as FilePath, text: "b\n", base: 0, author: ada },
    ]);
  } finally {
    console.error = log;
  }
  assert.deepEqual(heard, ["B.md"]);
});

test("a one-line save to a long note, and a merge into one from a stale base, take moments, not seconds", () => {
  // A blank line in every ten: each blank matches every other, which made the whole-text diff slow.
  const before = Array.from({ length: 10_000 }, (_, i) => (i % 10 === 9 ? "" : `line ${i}`));
  const edit = (at: number, line: string, from = before) => from.map((l, i) => (i === at ? line : l));
  const notes = workspace();
  const first = notes.write({ path: PLAN, text: before.join("\n"), base: 0, author: ada });
  const timed = (fn: () => void) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  let theirs = first;
  const save = timed(() => (theirs = notes.write({ path: PLAN, text: edit(9_000, "theirs").join("\n"), base: first.file!.revision, author: bot })));
  let merged = theirs;
  const merge = timed(() => (merged = notes.write({ path: PLAN, text: edit(100, "mine").join("\n"), base: first.file!.revision, author: ada })));
  assert.equal(merged.status, "merged");
  assert.deepEqual(merged.file?.text, edit(100, "mine", edit(9_000, "theirs")).join("\n"));
  assert.ok(save < 1000, `a one-line save took ${Math.round(save)} ms`);
  assert.ok(merge < 1000, `a merge from a stale base took ${Math.round(merge)} ms`);
});

test("an edit's id is kept once it's saved or merged, not when it clashes, so a page that went can ask", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "one\ntwo\nthree\n", base: 0, author: ada, edit: "first" });
  assert.equal(notes.editApplied(PLAN, "first"), true);
  notes.write({ path: PLAN, text: "one\ntwo\nthree!\n", base: 1, author: bot });
  // A stale base merged in is applied.
  assert.equal(notes.write({ path: PLAN, text: "one!\ntwo\nthree\n", base: 1, author: ada, edit: "merged" }).status, "merged");
  assert.equal(notes.editApplied(PLAN, "merged"), true);
  // A clash saves nothing, so it isn't.
  assert.equal(notes.write({ path: PLAN, text: "uno\ntwo\nthree\n", base: 1, author: ada, edit: "clashed" }).status, "conflict");
  assert.equal(notes.editApplied(PLAN, "clashed"), false);
  assert.equal(notes.editApplied(PLAN, "never"), false);
  assert.equal(notes.editApplied("Other.md" as FilePath, "first"), false);
});

test("an edit id is kept for 30 days, however many edits come after it", () => {
  let clock = 0;
  const notes = new Files(memoryDb(), () => clock);
  notes.write({ path: PLAN, text: "0\n", base: 0, author: ada, edit: "first" });
  for (let i = 1; i <= 200; i++) notes.write({ path: PLAN, text: `${i}\n`, base: i, author: ada, edit: `e${i}` });
  assert.equal(notes.editApplied(PLAN, "first"), true, "after 200 more");
  clock = 31 * 86_400_000;
  notes.write({ path: PLAN, text: "later\n", base: 201, author: ada, edit: "later" });
  assert.equal(notes.editApplied(PLAN, "first"), false, "a month on");
  assert.equal(notes.editApplied(PLAN, "later"), true);
});

test("an edit id is for one text: sent again with other text, it's refused, not said to be saved", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Trip\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Trip\n- A\n", base: 1, author: bot, edit: "edit-1" });
  const again = notes.write({ path: PLAN, text: "# Trip\n- A\n- B\n", base: 2, author: bot, edit: "edit-1" });
  assert.equal(again.status, "conflict");
  assert.equal(again.status === "conflict" && again.reason, "This edit id was already used for different text");
  assert.equal(notes.read(PLAN)?.text, "# Trip\n- A\n");
});

test("an edit sent again after its file was deleted doesn't bring the file back", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Trip\n", base: 0, author: ada, edit: "made" });
  notes.write({ path: PLAN, text: "", base: 1, author: bot, delete: true });
  assert.equal(notes.write({ path: PLAN, text: "# Trip\n", base: 0, author: ada, edit: "made" }).status, "conflict");
  assert.equal(notes.read(PLAN), null);
});

test("an edit sent again with its id, after the file moved on, is in already: it isn't merged in a second time", () => {
  const notes = workspace();
  notes.write({ path: PLAN, text: "# Trip\n- a\n", base: 0, author: ada });
  notes.write({ path: PLAN, text: "# Trip\n- a\n- packed\n", base: 1, author: ada, edit: "went" });
  // Someone deletes the line it added; then the same edit arrives again, on its old base.
  notes.write({ path: PLAN, text: "# Trip\n- a\n", base: 2, author: bot });
  const again = notes.write({ path: PLAN, text: "# Trip\n- a\n- packed\n", base: 1, author: ada, edit: "went" });
  assert.deepEqual(again, { status: "saved", file: { path: PLAN, text: "# Trip\n- a\n", revision: 3 } });
  assert.equal(notes.history(PLAN).length, 3);
});
