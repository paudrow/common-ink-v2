import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../worker/src/data-sources.ts";
import type { Author, FilePath } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };

function workspace() {
  const db = memoryDb();
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  const write = (path: string, text: string) => files.write({ path: path as FilePath, text, base: files.read(path as FilePath)?.revision ?? 0, author: ada });
  const remove = (path: string) => files.write({ path: path as FilePath, text: "", base: files.read(path as FilePath)!.revision, author: ada, delete: true });
  return { db, files, write, remove };
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

test("a purged note's words leave the search index's blocks", () => {
  const { db, files, write, remove } = workspace();
  for (let i = 0; i < 20; i++) write(`Note ${i}.md`, `# Note ${i}\nwords for note ${i}`);
  write("Secret.md", "# Secret\nquokkamarker zebramarker");
  write("After.md", "# After\nother words");
  files.purge([remove("Secret.md").file!.revision], ada);
  const blobs = db.raw.prepare("SELECT block FROM search_data").all().map((r) => Buffer.from(r.block as Uint8Array).toString("latin1")).join("");
  assert.equal(blobs.includes("quokkamarker"), false);
  assert.equal(blobs.includes("other"), true, "the index's blocks are what's read");
});

test("a note brought back at its path stays out of Trash, even once that restore is undone", () => {
  const { files, write, remove } = workspace();
  write("Back.md", "# Back\ntext");
  const d = remove("Back.md").file!.revision;
  const [restored] = files.undo([d], ada);
  files.undo([restored.file!.revision], ada);
  assert.deepEqual([files.deleted(0).map((x) => x.path), files.purge([d], ada)], [[], []]);
});
