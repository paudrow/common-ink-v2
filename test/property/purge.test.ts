import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../../worker/src/data-sources.ts";
import { authorKey, type Author, type FilePath, type Files, type Revision, type Write } from "../../worker/src/files.ts";
import { restoreFromTrash } from "../../worker/src/trash.ts";
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
  | { op: "undo"; picks: Array<{ path: FilePath; back: number }>; author: number }
  | { op: "restoreTo"; path: FilePath; back: number }
  | { op: "trashRestore"; path: FilePath; which: number }
  | { op: "replay"; pick: number }
  | { op: "purge"; path: FilePath; which: number };

/** Every line names its note and the step that wrote it, so a purged note's words can be looked for afterwards. */
const line = (r: Rng, path: string, at: number) => `${path.replace(/\W/g, "")}secret${at}x${r.int(0, 9)} ${r.pick(["one", "two", "three"])}`;

const step = (r: Rng, at: number): Step => {
  const path = r.pick(PATHS);
  const author = r.int(0, AUTHORS.length - 1);
  switch (r.pick(["write", "write", "write", "delete", "undo", "restoreTo", "trashRestore", "replay", "purge", "purge"] as const)) {
    case "write":
      return { op: "write", path, lines: r.array(0, 4, () => line(r, path, at)), author, stale: r.bool(0.2) };
    case "delete":
      return { op: "delete", path, author };
    case "undo":
      return { op: "undo", picks: r.array(1, 3, () => ({ path: r.pick(PATHS), back: r.int(0, 3) })), author };
    case "restoreTo":
      return { op: "restoreTo", path, back: r.int(0, 4) };
    case "trashRestore":
      return { op: "trashRestore", path, which: r.int(0, 2) };
    case "replay":
      return { op: "replay", pick: r.int(0, 50) };
    case "purge":
      return { op: "purge", path, which: r.int(0, 2) };
  }
};
const steps = (r: Rng) => Array.from({ length: r.int(1, 45) }, (_, i) => step(r, i));

/**
 * Run steps on a fresh workspace. The twin (`purge` false) never purges, but at each purge it works out
 * the same lifetime the purging run removes, and leaves those changes out of every later choice, so
 * both runs choose the same changes to undo, restore and base writes on.
 */
function run(steps: readonly Step[], purge: boolean) {
  const db = memoryDb();
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  /** Changes a purge took (or, in the twin, would have). */
  const gone = new Set<Revision>();
  const purgedText: string[] = [];
  const sent: Write[] = [];
  const resurrected: string[] = [];
  const live = (path: FilePath) => files.history(path).filter((c) => !c.purged && !gone.has(c.revision));
  // Which note each change belongs to, worked out from the changes as they come: a change at a path
  // with no note makes a new one, unless it undoes the delete just before it there (Restore, in place).
  const noteOf = new Map<Revision, number>();
  const noteAt = new Map<string, number | null>();
  const lastAt = new Map<string, Revision>();
  let notes = 0;
  let seen = 0;
  const follow = () => {
    for (const c of files.recent({ limit: 500 }).filter((c) => c.revision > seen).reverse()) {
      seen = c.revision;
      if (c.purged) continue;
      let note = noteAt.get(c.path) ?? null;
      if (note === null) note = c.undoes !== null && c.undoes === lastAt.get(c.path) ? noteOf.get(c.undoes)! : ++notes;
      noteOf.set(c.revision, note);
      noteAt.set(c.path, c.deleted ? null : note);
      lastAt.set(c.path, c.revision);
    }
  };
  const trashed = (path: FilePath) => files.deleted(0).filter((d) => d.path === path && !gone.has(d.revision));
  for (const [i, s] of steps.entries()) {
    follow();
    if (s.op === "write") {
      const current = files.read(s.path);
      const history = live(s.path);
      // A stale write is based on the file's previous revision, so it's merged (or refused) like an agent's late edit.
      const base = s.stale && history.length > 1 ? history.at(-2)!.revision : (current?.revision ?? 0);
      const w = { path: s.path, text: s.lines.join("\n"), base, author: AUTHORS[s.author], edit: `step${i}` };
      sent.push(w);
      files.write(w);
    } else if (s.op === "delete") {
      const current = files.read(s.path);
      if (current) files.write({ path: s.path, text: "", base: current.revision, author: AUTHORS[s.author], delete: true });
    } else if (s.op === "undo") {
      const revisions = s.picks.flatMap(({ path, back }) => live(path).at(-1 - back)?.revision ?? []);
      if (revisions.length) files.undo(revisions, AUTHORS[s.author]);
    } else if (s.op === "restoreTo") {
      const c = live(s.path).at(-1 - s.back);
      if (c) files.restore(s.path, { revision: c.revision }, ME);
    } else if (s.op === "trashRestore") {
      const d = trashed(s.path)[s.which];
      if (d) restoreFromTrash(files, d, ME);
    } else if (s.op === "replay" && sent.length) {
      // A page that never heard the answer sends the same edit again.
      const w = sent[s.pick % sent.length];
      const before = files.read(w.path)?.text ?? null;
      const result = files.write(w);
      if (result.status !== "conflict" && purgedText.includes(w.text) && files.read(w.path)?.text !== before) resurrected.push(`${w.path} by a replay of ${w.edit}`);
    } else if (s.op === "purge") {
      const d = trashed(s.path)[s.which];
      if (!d) continue;
      const lifetime = files.lifetime(d.revision);
      const expected = files.history(s.path).filter((c) => !c.purged && !gone.has(c.revision) && noteOf.get(c.revision) === noteOf.get(d.revision)).map((c) => c.revision);
      assert.deepEqual(lifetime, expected, `the deleted note's changes: ${JSON.stringify(steps.slice(0, i + 1))}`);
      for (const r of lifetime) {
        gone.add(r);
        const text = files.versionAt(s.path, r);
        if (text) purgedText.push(text);
      }
      if (purge) assert.deepEqual(files.purge([d.revision], ME).map((p) => p.path), [s.path]);
    }
  }
  return { files, db, gone, resurrected };
}

/** A file's history as it reads, without revision numbers or what a purge took: who, what, and the text after each change. */
function story(files: Files, path: FilePath, gone: ReadonlySet<Revision>) {
  const history = files.history(path).filter((c) => !c.purged && !gone.has(c.revision));
  const index = new Map(history.map((c, i) => [c.revision, i]));
  return history.map((c) => ({
    author: authorKey(c.author),
    diff: c.diff,
    deleted: c.deleted ?? false,
    undoes: c.undoes === null ? null : (index.get(c.undoes) ?? "elsewhere"),
    text: files.versionAt(path, c.revision),
  }));
}

test("purging a deleted note, at any point, leaves every other note's history replaying the same, at its own path too", () => {
  forAll(
    steps,
    (s) => {
      const purging = run(s, true);
      const twin = run(s, false);
      for (const path of PATHS) {
        assert.deepEqual(story(purging.files, path, purging.gone), story(twin.files, path, twin.gone), `${path}'s history`);
        assert.deepEqual(purging.files.read(path)?.text ?? null, twin.files.read(path)?.text ?? null, `${path} as it is now`);
        for (const c of purging.files.history(path)) assert.notEqual(purging.files.versionAt(path, c.revision), null, `${path} at ${c.revision} can be read`);
      }
    },
    { runs: 500 },
  );
});

test("a replayed edit never brings a purged note's text back", () => {
  forAll(steps, (s) => assert.deepEqual(run(s, true).resurrected, []), { runs: 500 });
});

test("a purge takes a note's text out of history, leaving one change that says who purged it and when", () => {
  forAll(
    // Not shrunk as a list: the last three steps are the point.
    (r) => ({
      steps: [
        ...steps(r).filter((s) => s.op !== "trashRestore" && s.op !== "restoreTo" && s.op !== "replay"),
        { op: "write", path: "a.md", lines: ["amdonlymarker"], author: 0, stale: false } as Step,
        { op: "delete", path: "a.md", author: 0 } as Step,
        { op: "purge", path: "a.md", which: 0 } as Step,
      ],
    }),
    ({ steps: s }) => {
      const { files, db } = run(s, true);
      const marker = files.history("a.md" as FilePath).at(-1)!;
      assert.deepEqual({ purged: marker.purged, author: marker.author, diff: marker.diff }, { purged: true, author: ME, diff: [] });
      // The last note's words are nowhere: not in any table's rows, and not in the search index.
      for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
        const rows = JSON.stringify(db.raw.prepare(`SELECT * FROM "${name}"`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
        assert.ok(!rows.includes("amdonlymarker"), `a.md's text is still in ${name}`);
      }
      assert.deepEqual(db.all("SELECT rowid FROM search WHERE search MATCH 'amdonlymarker'"), []);
    },
    { runs: 300 },
  );
});
