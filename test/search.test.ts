import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../worker/src/data-sources.ts";
import { Files, type Author, type FilePath } from "../worker/src/files.ts";
import { runOperation } from "../worker/src/operations.ts";
import { memoryDb } from "./sqlite.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const claude: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };

async function search(store: ReturnType<typeof memoryStore>, query: string, author: Author = ada) {
  const out = await runOperation("search", { query, zone: "UTC" }, store, author);
  assert.ok(out.ok, JSON.stringify(out));
  return out.value as { query: string; problems: string[]; total: number; results: Array<{ path: string; line?: { number: number; text: string } }> };
}

test("search finds notes by their words, title matches first, with the line that matched", async () => {
  const store = memoryStore();
  store.files.write({ path: "Projects/Launch plan.md" as FilePath, text: "# Launch plan\nShip the beta on Oct 20.", base: 0, author: claude });
  store.files.write({ path: "Journal/2026-10-05.md" as FilePath, text: "# Monday\nTalked about the launch.\nThen lunch.", base: 0, author: ada });
  store.files.write({ path: "Groceries.md" as FilePath, text: "# Groceries\nEggs", base: 0, author: ada });
  const found = await search(store, "launch");
  assert.deepEqual(
    found.results.map((r) => [r.path, r.line]),
    [
      ["Projects/Launch plan.md", { number: 1, text: "# Launch plan" }],
      ["Journal/2026-10-05.md", { number: 2, text: "Talked about the launch." }],
    ],
  );
  assert.deepEqual((await search(store, "laun from:agent")).results.map((r) => r.path), ["Projects/Launch plan.md"]);
  assert.deepEqual((await search(store, "-launch in:journal")).results.map((r) => r.path), []);
});

test("search follows edits and deletes as they're written", async () => {
  const store = memoryStore();
  const first = store.files.write({ path: "Notes.md" as FilePath, text: "# Notes\nalpha", base: 0, author: ada });
  assert.equal((await search(store, "alpha")).total, 1);
  const second = store.files.write({ path: "Notes.md" as FilePath, text: "# Notes\nbravo", base: first.file!.revision, author: ada });
  assert.deepEqual([(await search(store, "alpha")).total, (await search(store, "bravo")).total], [0, 1]);
  store.files.write({ path: "Notes.md" as FilePath, text: "", base: second.file!.revision, author: ada, delete: true });
  assert.equal((await search(store, "bravo")).total, 0);
});

test("search says how it read the query, and what's wrong with it", async () => {
  const found = await search(memoryStore(), "  beta   IS:shiny");
  assert.deepEqual([found.query, found.problems], ["beta is:shiny", ["is: is one of archived, pinned, trashed, open, done"]]);
});

test("a workspace from before search is indexed when it opens", () => {
  const db = memoryDb();
  const old = new Files(db);
  old.write({ path: "Old note.md" as FilePath, text: "# Old note\nsomething remembered", base: 0, author: ada });
  const { search } = openWorkspace(db, { fixtures: false, google: null });
  assert.deepEqual(search.search({ terms: [{ kind: "words", text: "remembered", negated: false }] }, { ctx: { now: 0, zone: "UTC" }, limit: 5 }).results.map((r) => r.path), ["Old note.md"]);
});
