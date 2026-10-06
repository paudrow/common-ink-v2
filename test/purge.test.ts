import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../worker/src/data-sources.ts";
import { Files, type Author, type FilePath } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };

function workspace() {
  const db = memoryDb();
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  const write = (path: string, text: string) => files.write({ path: path as FilePath, text, base: files.read(path as FilePath)?.revision ?? 0, author: ada });
  const remove = (path: string) => files.write({ path: path as FilePath, text: "", base: files.read(path as FilePath)!.revision, author: ada, delete: true });
  return { db, files, write, remove };
}

test("only a deleted note can be purged", () => {
  const { files, write } = workspace();
  write("Live.md", "# Live\nkeep me");
  assert.deepEqual(files.purge(["Live.md", "Never.md"] as FilePath[], ada), []);
  assert.deepEqual(files.history("Live.md" as FilePath).map((c) => c.purged ?? false), [false]);
});

test("undo can't reach a purge, and a note made again at a purged path starts a new history", () => {
  const { files, write, remove } = workspace();
  write("Gone.md", "# Gone\nsecret");
  remove("Gone.md");
  const [{ revision }] = files.purge(["Gone.md" as FilePath], ada);
  assert.deepEqual(files.undo([revision], ada).map((u) => u.status), ["missing"]);
  assert.equal(files.read("Gone.md" as FilePath), null);
  write("Gone.md", "# Gone\nnew words");
  assert.deepEqual(files.history("Gone.md" as FilePath).map((c) => [c.purged ?? false, files.versionAt(c.path, c.revision)]), [[true, ""], [false, "# Gone\nnew words"]]);
});

test("an index made before secure deletes is made again, so deleted notes' words leave it", () => {
  const db = memoryDb();
  const old = new Files(db);
  old.write({ path: "Kept.md" as FilePath, text: "# Kept", base: 0, author: ada });
  db.run("CREATE TABLE IF NOT EXISTS search_docs(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE)");
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(words, tokenize = 'unicode61 remove_diacritics 2')");
  openWorkspace(db, { fixtures: false, google: null });
  assert.deepEqual(db.all("SELECT v FROM search_config WHERE k = 'secure-delete'"), [{ v: 1 }]);
  assert.deepEqual(db.all("SELECT path FROM search_docs"), [{ path: "Kept.md" }]);
});

test("a deleted note's words leave the search index at once", () => {
  const { db, write, remove } = workspace();
  for (let i = 0; i < 20; i++) write(`Note ${i}.md`, `# Note ${i}\nwords for note ${i}`);
  write("Secret.md", "# Secret\nquokkamarker zebramarker");
  write("After.md", "# After\nother words");
  remove("Secret.md");
  const blobs = db.raw.prepare("SELECT block FROM search_data").all().map((r) => Buffer.from(r.block as Uint8Array).toString("latin1")).join("");
  assert.equal(blobs.includes("quokkamarker"), false);
  assert.equal(blobs.includes("other"), true, "the index's blocks are what's read");
});
