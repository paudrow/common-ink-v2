import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../worker/src/data-sources.ts";
import { Files, type Author, type FilePath } from "../worker/src/files.ts";
import { restoreFromTrash } from "../worker/src/trash.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };

function workspace() {
  const db = memoryDb();
  const { files, search } = openWorkspace(db, { fixtures: false, google: null });
  const write = (path: string, text: string) => files.write({ path: path as FilePath, text, base: files.read(path as FilePath)?.revision ?? 0, author: ada });
  const remove = (path: string) => files.write({ path: path as FilePath, text: "", base: files.read(path as FilePath)!.revision, author: ada, delete: true });
  return { db, files, search, write, remove };
}

test("only a delete in effect can be purged: not a write, nor a delete that was restored", () => {
  const { files, write, remove } = workspace();
  const w = write("Live.md", "# Live\nkeep me").file!.revision;
  const d = remove("Live.md").file!.revision;
  files.undo([d], ada);
  assert.deepEqual(files.purge([w, d, 9999], ada), []);
  assert.deepEqual(files.history("Live.md" as FilePath).map((c) => c.purged ?? false), [false, false, false]);
});

test("undo can't reach a purge, and a note made again at a purged path starts a new history", () => {
  const { files, write, remove } = workspace();
  write("Gone.md", "# Gone\nsecret");
  const d = remove("Gone.md").file!.revision;
  const [{ revision }] = files.purge([d], ada);
  assert.deepEqual(files.undo([revision], ada).map((u) => u.status), ["missing"]);
  assert.equal(files.read("Gone.md" as FilePath), null);
  write("Gone.md", "# Gone\nnew words");
  assert.deepEqual(files.history("Gone.md" as FilePath).map((c) => [c.purged ?? false, files.versionAt(c.path, c.revision)]), [[true, ""], [false, "# Gone\nnew words"]]);
});

test("a purged note's words leave the search index's blocks when it's next merged, once for any number of purges", () => {
  const { db, files, search, write, remove } = workspace();
  for (let i = 0; i < 20; i++) write(`Note ${i}.md`, `# Note ${i}\nwords for note ${i}`);
  write("Secret.md", "# Secret\nquokkamarker zebramarker");
  write("After.md", "# After\nother words");
  const blobs = () => db.raw.prepare("SELECT block FROM search_data").all().map((r) => Buffer.from(r.block as Uint8Array).toString("latin1")).join("");
  assert.equal(search.mergeDue(), false);
  files.purge([remove("Secret.md").file!.revision], ada);
  // Deleting forever doesn't rewrite the index: the workspace's alarm merges it soon after.
  assert.deepEqual([search.mergeDue(), db.all("SELECT rowid FROM search WHERE search MATCH 'quokkamarker'")], [true, []]);
  search.mergePurged();
  assert.deepEqual([search.mergeDue(), blobs().includes("quokkamarker"), blobs().includes("other")], [false, false, true], "the index's blocks are what's read");
});

test("deleting forever a copy restored beside a new note takes the note it was restored from, and nothing comes back into Trash", () => {
  const { db, files, write, remove } = workspace();
  write("Plan.md", "# Plan\nthe password is hunter2");
  const d1 = remove("Plan.md").file!.revision;
  // A new note takes the name, so Restore puts the old one beside it.
  write("Plan.md", "# Plan\nnew plan");
  const restored = restoreFromTrash(files, files.deleted(0).find((d) => d.revision === d1)!, ada);
  assert.equal(restored.path, "Plan (restored).md");
  assert.deepEqual(files.deleted(0), []);
  const d2 = remove("Plan (restored).md").file!.revision;
  assert.deepEqual(files.lifetime(d2).length, 4, "the note's changes at both paths");
  assert.deepEqual(files.purge([d2], ada).map((p) => p.path).sort(), ["Plan (restored).md", "Plan.md"]);
  assert.deepEqual(files.deleted(0), []);
  assert.equal(files.read("Plan.md" as FilePath)?.text, "# Plan\nnew plan");
  assert.ok(!JSON.stringify(db.all("SELECT * FROM changes")).includes("hunter2"));
  for (const path of ["Plan.md", "Plan (restored).md"] as FilePath[]) for (const c of files.history(path)) assert.notEqual(files.versionAt(path, c.revision), null);
});

test("a restored copy whose restore was undone is the same note: deleting it forever leaves its text nowhere", () => {
  const { db, files, write, remove } = workspace();
  write("Plan.md", "# Plan\nthe password is hunter2");
  const d1 = remove("Plan.md").file!.revision;
  write("Plan.md", "# Plan\nnew plan");
  const restored = restoreFromTrash(files, files.deleted(0).find((d) => d.revision === d1)!, ada);
  // Undoing the restore empties the copy, which is still the note, so the original's delete doesn't come back into Trash.
  files.undo([restored.revision], ada);
  assert.deepEqual([files.deleted(0), files.purge([d1], ada)], [[], []]);
  // Deleted, it's in Trash once, and deleting it forever takes the original's changes with it.
  const d2 = remove("Plan (restored).md").file!.revision;
  assert.deepEqual(files.deleted(0).map((d) => d.revision), [d2]);
  files.purge([d2], ada);
  assert.deepEqual(files.deleted(0), []);
  assert.ok(!JSON.stringify(db.all("SELECT * FROM changes")).includes("hunter2"));
});

test("a database from before notes were known by id gets them from its history, once", () => {
  const db = memoryDb();
  let files = new Files(db);
  const ada2 = { kind: "user", email: "ada@example.com" } as const;
  const w = (path: string, text: string, extra: object = {}) => files.write({ path: path as FilePath, text, base: files.read(path as FilePath)?.revision ?? 0, author: ada2, ...extra }).file!.revision;
  w("A.md", "# A\none");
  const d1 = w("A.md", "", { delete: true });
  w("A.md", "# A\nanother note");
  const d2 = w("A.md", "", { delete: true, base: files.read("A.md" as FilePath)!.revision });
  files.undo([d2], ada2);
  const d3 = w("A.md", "", { delete: true, base: files.read("A.md" as FilePath)!.revision });
  const before = [files.lifetime(d1), files.lifetime(d3)];
  db.run("DROP INDEX IF EXISTS changes_by_note");
  db.run("ALTER TABLE changes DROP COLUMN note");
  files = new Files(db);
  assert.deepEqual([files.lifetime(d1), files.lifetime(d3)], before);
  assert.deepEqual(files.deleted(0).map((d) => d.revision), [d3, d1]);
});

test("a note brought back at its path stays out of Trash, even once that restore is undone", () => {
  const { files, write, remove } = workspace();
  write("Back.md", "# Back\ntext");
  const d = remove("Back.md").file!.revision;
  const [restored] = files.undo([d], ada);
  files.undo([restored.file!.revision], ada);
  assert.deepEqual([files.deleted(0).map((x) => x.path), files.purge([d], ada)], [[], []]);
});

test("a note is a file at one path at a time: bringing back its text where it isn't starts another note", () => {
  const { files, write, remove } = workspace();
  write("A.md", "# A\nold words");
  const d1 = remove("A.md").file!.revision;
  write("A.md", "# A\nnew note");
  restoreFromTrash(files, files.deleted(0).find((d) => d.revision === d1)!, ada);
  remove("A.md");
  // The old delete undone again at its own path, while the note is beside it as a copy: a second note.
  files.undo([d1], ada);
  const d2 = remove("A (restored).md").file!.revision;
  assert.deepEqual(files.deleted(0).map((d) => d.revision).includes(d2), true);
  assert.deepEqual(files.purge([d2], ada).some((p) => p.path === "A (restored).md"), true);
  assert.equal(files.read("A.md" as FilePath)?.text, "# A\nold words");
  for (const c of files.history("A.md" as FilePath)) assert.notEqual(files.versionAt("A.md" as FilePath, c.revision), null);
});
