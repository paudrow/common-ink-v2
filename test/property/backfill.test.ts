// Schema step 6 gives notes to history written before notes had ids. Live writes know when a file is
// restored to an older version (`from`); history doesn't say, so the backfill links a new file to the
// note whose earlier version it repeats exactly, and keeps any delete it can't be sure of out of
// Trash retention's automatic purge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../../worker/src/data-sources.ts";
import { Files, type Author, type FilePath } from "../../worker/src/files.ts";
import { expired, restoreFromTrash } from "../../worker/src/trash.ts";
import { memoryDb } from "../sqlite.ts";
import { forAll, type Rng } from "./gen.ts";

const PATHS = ["a.md", "b.md", "a (restored).md", "b (restored).md"] as FilePath[];
const ME: Author = { kind: "user", email: "ada@example.com" };
type Step = { op: "write" | "delete" | "undo" | "restoreTo" | "trashRestore" | "purge"; path: FilePath; back: number; k: number };
// Few texts, an empty one among them, so the same text often comes back in another note.
const step = (r: Rng): Step => ({ op: r.pick(["write", "write", "delete", "undo", "restoreTo", "restoreTo", "trashRestore", "purge"] as const), path: r.pick(PATHS), back: r.int(0, 3), k: r.int(0, 5) });

function build(steps: readonly Step[]) {
  const db = memoryDb();
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  for (const s of steps) {
    const current = files.read(s.path);
    const history = files.history(s.path).filter((c) => !c.purged);
    if (s.op === "write") files.write({ path: s.path, text: s.k ? `${s.path} ${s.k}` : "", base: current?.revision ?? 0, author: ME });
    else if (s.op === "delete" && current) files.write({ path: s.path, text: "", base: current.revision, author: ME, delete: true });
    else if (s.op === "undo") {
      const c = history.at(-1 - s.back);
      if (c) files.undo([c.revision], ME);
    } else if (s.op === "restoreTo") {
      // To an older version, whether or not the file is there now.
      const c = history.at(-1 - s.back);
      if (c) files.restore(s.path, { revision: c.revision }, ME);
    } else if (s.op === "trashRestore") {
      const d = files.deleted(0).filter((d) => d.path === s.path)[s.back % 2];
      if (d) restoreFromTrash(files, d, ME);
    } else if (s.op === "purge") {
      const d = files.deleted(0).find((d) => d.path === s.path);
      if (d) files.purge([d.revision], ME);
    }
  }
  return { db, files };
}

/** The workspace as an older one would be: its notes worked out again from history. */
function backfill(db: ReturnType<typeof memoryDb>) {
  db.run("DROP INDEX changes_by_note");
  db.run("ALTER TABLE changes DROP COLUMN note");
  db.run("ALTER TABLE changes DROP COLUMN purge_by_hand");
  return new Files(db);
}

let differed = 0;
test("after the backfill, Trash retention purges only what live writes would, and only the same changes", () => {
  forAll(
    (r) => r.array(1, 40, step),
    (steps) => {
      const { db, files } = build(steps);
      const live = new Map(files.deleted(0).map((d) => [d.revision, files.lifetime(d.revision)]));
      const notes = db.all("SELECT revision, note FROM changes ORDER BY revision");
      const old = backfill(db);
      if (JSON.stringify(db.all("SELECT revision, note FROM changes ORDER BY revision")) !== JSON.stringify(notes)) differed++;
      // Every delete the alarm may purge on its own was in Trash for live writes too. What it takes is
      // that note's changes as live writes say, or fewer (the rest stay in Trash, for you to purge), and
      // at most those of notes deleted before it, which retention would have purged sooner anyway.
      for (const d of expired(old, 0, Date.now() + 1)) {
        assert.ok(live.has(d), `delete ${d} is purged automatically, but live writes didn't have it in Trash`);
        for (const r of old.lifetime(d).filter((r) => !live.get(d)!.includes(r))) {
          const owner = [...live].find(([, changes]) => changes.includes(r));
          assert.ok(owner && owner[0] < d, `delete ${d}'s note takes change ${r}, which live writes didn't have in Trash before it`);
        }
      }
      // What live writes had in Trash stays there, unless the backfill guessed its note went on (a new
      // file repeated one of its versions exactly, as a restore to that version would): then it's kept
      // from automatic purge.
      const listed = new Set(old.deleted(0).map((d) => d.revision));
      for (const d of live.keys()) {
        if (listed.has(d)) continue;
        const guessed = db.all("SELECT 1 FROM changes WHERE note = (SELECT note FROM changes WHERE revision = ?) AND purge_by_hand = 1", d);
        assert.ok(guessed.length, `delete ${d} left Trash, though no guess took its note on`);
      }
      // And it's the same each time.
      const once = db.all("SELECT revision, note, purge_by_hand FROM changes ORDER BY revision");
      backfill(db);
      assert.deepEqual(db.all("SELECT revision, note, purge_by_hand FROM changes ORDER BY revision"), once);
    },
    { runs: 1500 },
  );
  console.log(`# histories whose backfilled notes differ from live ones (all kept from automatic purge): ${differed}`);
});

test("restored to an older version while deleted, a note is the same note after the backfill", () => {
  const { db, files } = build([]);
  const r1 = files.write({ path: "r.md" as FilePath, text: "# r\nsecret", base: 0, author: ME }).file!.revision;
  const d1 = files.write({ path: "r.md" as FilePath, text: "", base: r1, author: ME, delete: true }).file!.revision;
  files.restore("r.md" as FilePath, { revision: r1 }, ME);
  const notes = db.all("SELECT revision, note FROM changes ORDER BY revision");
  const old = backfill(db);
  assert.deepEqual(db.all("SELECT revision, note FROM changes ORDER BY revision"), notes);
  assert.deepEqual(old.deleted(0), [], `delete ${d1} stays out of Trash`);
});

test("a delete followed by a new note at its path the backfill can't link stays in Trash past retention, for you to purge", () => {
  const { db, files } = build([]);
  const w = (text: string) => files.write({ path: "n.md" as FilePath, text, base: files.read("n.md" as FilePath)?.revision ?? 0, author: ME }).file!.revision;
  w("# n\nfirst");
  const d1 = files.write({ path: "n.md" as FilePath, text: "", base: files.read("n.md" as FilePath)!.revision, author: ME, delete: true }).file!.revision;
  w("# n\nsecond, a new note");
  // Live writes know it's a new note, and Trash retention may purge the old one.
  assert.deepEqual(expired(files, 0, Date.now() + 1), [d1]);
  const old = backfill(db);
  assert.deepEqual(expired(old, 0, Date.now() + 1), [], "not purged automatically");
  db.run("UPDATE changes SET time = 0 WHERE revision = ?", d1);
  assert.deepEqual(old.deleted(Date.now() - 1000).map((d) => [d.revision, d.byHand]), [[d1, true]], "still in Trash, long after");
  assert.deepEqual(old.purge([d1], ME).map((p) => p.path), ["n.md"], "and purged by hand");
  assert.equal(old.read("n.md" as FilePath)?.text, "# n\nsecond, a new note");
});
