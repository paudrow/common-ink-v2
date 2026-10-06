import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../../worker/src/data-sources.ts";
import { authorKey, type Author, type FilePath, type Files } from "../../worker/src/files.ts";
import { memoryDb } from "../sqlite.ts";
import { forAll, type Rng } from "./gen.ts";

const PATHS = ["a.md", "b.md", "Projects/c.md", "d.md"] as FilePath[];
const AUTHORS: Author[] = [
  { kind: "user", email: "ada@example.com" },
  { kind: "agent", name: "Claude", by: "ada@example.com" },
];
const ME = AUTHORS[0];

type Step =
  | { op: "write"; path: FilePath; lines: string[]; author: number; stale: boolean }
  | { op: "delete"; path: FilePath; author: number }
  | { op: "undo"; path: FilePath; back: number; author: number }
  | { op: "restore"; path: FilePath }
  | { op: "purge"; path: FilePath };

/** Every line a note ever had names its note, so the purged note's words can be looked for everywhere afterwards. */
const line = (r: Rng, path: string) => `${path.replace(/\W/g, "")}secret${r.int(0, 9)} ${r.pick(["one", "two", "three"])}`;

const step = (r: Rng): Step => {
  const path = r.pick(PATHS);
  const author = r.int(0, AUTHORS.length - 1);
  switch (r.pick(["write", "write", "write", "delete", "undo", "restore", "purge"] as const)) {
    case "write":
      return { op: "write", path, lines: r.array(0, 4, () => line(r, path)), author, stale: r.bool(0.2) };
    case "delete":
      return { op: "delete", path, author };
    case "undo":
      return { op: "undo", path, back: r.int(0, 3), author };
    case "restore":
      return { op: "restore", path };
    case "purge":
      return { op: "purge", path };
  }
};

/** Run steps on a fresh workspace. `purge` false skips purges, for the twin that never purged. */
function run(steps: readonly Step[], purge: boolean): { files: Files; db: ReturnType<typeof memoryDb>; purged: Set<FilePath> } {
  const db = memoryDb();
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  const purged = new Set<FilePath>();
  for (const [i, s] of steps.entries()) {
    const current = files.read(s.path);
    if (s.op === "write") {
      // A stale write is based on the file's previous revision, so it's merged (or refused) like an agent's late edit.
      const history = files.history(s.path);
      const base = s.stale && history.length > 1 ? history.at(-2)!.revision : (current?.revision ?? 0);
      files.write({ path: s.path, text: s.lines.join("\n"), base, author: AUTHORS[s.author], edit: `step${i}` });
    } else if (s.op === "delete" && current) {
      files.write({ path: s.path, text: "", base: current.revision, author: AUTHORS[s.author], delete: true });
    } else if (s.op === "undo") {
      const change = files.history(s.path).filter((c) => !c.purged).at(-1 - s.back);
      if (change) files.undo([change.revision], AUTHORS[s.author]);
    } else if (s.op === "restore") {
      const deleted = files.deleted(0).find((d) => d.path === s.path);
      if (deleted) files.undo([deleted.revision], ME);
    } else if (s.op === "purge" && purge && !current && files.history(s.path).some((c) => !c.purged)) {
      files.purge([s.path], ME);
      purged.add(s.path);
    }
  }
  return { files, db, purged };
}

/** A file's history as it reads, without revision numbers: who, what, and the text after each change. */
function story(files: Files, path: FilePath) {
  const history = files.history(path);
  const index = new Map(history.map((c, i) => [c.revision, i]));
  return history.map((c) => ({
    author: authorKey(c.author),
    diff: c.diff,
    deleted: c.deleted ?? false,
    undoes: c.undoes === null ? null : (index.get(c.undoes) ?? "elsewhere"),
    text: files.versionAt(path, c.revision),
  }));
}

test("purging a path, at any point, leaves every other file's history replaying the same", () => {
  forAll(
    (r) => r.array(1, 40, step),
    (steps) => {
      const purging = run(steps, true);
      const twin = run(steps, false);
      for (const path of PATHS.filter((p) => !purging.purged.has(p))) {
        assert.deepEqual(story(purging.files, path), story(twin.files, path), `${path}'s history`);
        assert.deepEqual(purging.files.read(path)?.text ?? null, twin.files.read(path)?.text ?? null, `${path} as it is now`);
      }
    },
    { runs: 400 },
  );
});

test("a purge takes a note's text out of history, leaving one change that says who purged it and when", () => {
  forAll(
    (r) => [...r.array(1, 25, step), { op: "delete", path: "a.md", author: 0 } as Step, { op: "purge", path: "a.md" } as Step],
    (steps) => {
      const { files, db, purged } = run(steps, true);
      if (!purged.has("a.md" as FilePath)) return;
      const history = files.history("a.md" as FilePath);
      assert.deepEqual(history.map((c) => ({ purged: c.purged, author: c.author, diff: c.diff })).at(-1), { purged: true, author: ME, diff: [] });
      assert.ok(history.every((c) => c.purged), "nothing of a.md is left but purges");
      // Its words are nowhere: not in any table's text, and not in the search index.
      for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
        const rows = JSON.stringify(db.raw.prepare(`SELECT * FROM "${name}"`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
        assert.ok(!rows.includes("amdsecret"), `a.md's text is still in ${name}`);
      }
      assert.deepEqual(db.all("SELECT rowid FROM search WHERE search MATCH 'amdsecret*'"), []);
      assert.deepEqual(db.all("SELECT id FROM edits WHERE path = 'a.md'"), [], "nor the ids of edits to it");
    },
    { runs: 300 },
  );
});

test("no purge can take another note's text", () => {
  forAll(
    (r) => r.array(1, 40, step),
    (steps) => {
      const { files, purged } = run(steps, true);
      for (const path of PATHS.filter((p) => !purged.has(p))) {
        for (const c of files.history(path)) assert.notEqual(files.versionAt(path, c.revision), null, `${path} at ${c.revision} can still be read`);
      }
    },
    { runs: 300 },
  );
});
