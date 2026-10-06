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

test("search finds a note by its own words, in any script", async () => {
  const store = memoryStore();
  const notes: Array<[string, string, string]> = [
    ["Korean.md", "# 여행\n한국 여행 계획", "한국"],
    ["Russian.md", "# План\nмой план", "мой"],
    ["Greek.md", "# Άλφα\nάλφα βήτα", "βήτα"],
    ["Japanese.md", "# 学校\nがっこう", "がっこう"],
    ["Hebrew.md", "# שלום\nשָׁלוֹם", "שלום"],
    ["Hindi.md", "# हिन्दी\nहिन्दी पाठ", "पाठ"],
    ["Arabic.md", "# كتاب\nكَتَبَ", "كتب"],
  ];
  for (const [path, text] of notes) store.files.write({ path: path as FilePath, text, base: 0, author: ada });
  for (const [path, , query] of notes) assert.deepEqual((await search(store, query)).results.map((r) => r.path), [path], `searching ${query}`);
  assert.deepEqual((await search(store, "पठ")).results, [], "a vowel sign makes another word");
});

test("a search of filters alone counts every note; one with words reads at most a thousand, and says there were more", async () => {
  const store = memoryStore();
  for (let i = 0; i < 1003; i++) store.files.write({ path: `N/${i}.md` as FilePath, text: `# ${i}\nalpha`, base: 0, author: ada });
  const all = await search(store, "-is:archived");
  const words = (await runOperation("search", { query: "alpha", zone: "UTC" }, store, ada)) as { ok: true; value: { total: number; more?: true } };
  assert.deepEqual([all.total, words.value.total, words.value.more], [1003, 1000, true]);
});

test("sort:edited and sort:title order every note with the words, not a sample of them", async (t) => {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  t.mock.method(Date, "now", () => (clock += 1000));
  const store = memoryStore();
  // Written oldest first, and titled so the newest note's title comes first: the notes a capped,
  // unordered sample would leave out are the ones each order puts first.
  for (let i = 0; i < 1003; i++) store.files.write({ path: `N/${i}.md` as FilePath, text: `# t${String(1002 - i).padStart(4, "0")}\nalpha`, base: 0, author: ada });
  const first = async (query: string) => (await runOperation("search", { query, zone: "UTC", limit: 3 }, store, ada)) as { ok: true; value: { results: Array<{ path: string; title: string }>; more?: true } };
  assert.deepEqual((await first("alpha sort:edited")).value.results.map((r) => r.path), ["N/1002.md", "N/1001.md", "N/1000.md"]);
  assert.deepEqual((await first("alpha sort:title")).value.results.map((r) => r.title), ["t0000", "t0001", "t0002"]);
  assert.equal((await first("alpha sort:title")).value.more, true);
});

test("-word and has: read notes in the query's order, so the first results are right, and say when they stopped short", async () => {
  const store = memoryStore();
  for (let i = 0; i < 1003; i++) store.files.write({ path: `N/${i}.md` as FilePath, text: `# t${String(i).padStart(4, "0")}\n- [ ] task ${i}`, base: 0, author: ada });
  for (const query of ["-zebra sort:title", "has:task sort:title"]) {
    const out = (await runOperation("search", { query, zone: "UTC", limit: 2 }, store, ada)) as { ok: true; value: { results: Array<{ title: string }>; total: number; more?: true } };
    assert.deepEqual([out.value.results.map((r) => r.title), out.value.total, out.value.more], [["t0000", "t0001"], 1000, true], query);
  }
});

test("a search within some paths ranks, limits and counts only the notes there", async () => {
  const store = memoryStore();
  store.files.write({ path: "Public/Decoy.md" as FilePath, text: "# Decoy\nzebra stripes", base: 0, author: ada });
  store.files.write({ path: "Secret/Plan.md" as FilePath, text: "# Zebra acquisition\nconfidential", base: 0, author: ada });
  for (let i = 0; i < 1001; i++) store.files.write({ path: `Secret/${i}.md` as FilePath, text: `# Secret ${i}\nzebra`, base: 0, author: ada });
  const within = async (query: string, limit: number) => (await runOperation("search", { query, zone: "UTC", limit, within: ["Public/**"] }, store, ada)) as { ok: true; value: { results: Array<{ path: string }>; total: number; more?: true } };
  for (const query of ["zebra", "zebra sort:title", "zebra sort:edited", "-giraffe", "is:pinned", "-is:archived"]) {
    const [one, twenty] = [await within(query, 1), await within(query, 20)];
    assert.deepEqual(one.value.results, twenty.value.results.slice(0, 1), query);
    assert.ok(twenty.value.results.every((r) => r.path.startsWith("Public/")), query);
    assert.equal(twenty.value.more, undefined, query);
    assert.equal(twenty.value.total, twenty.value.results.length, query);
  }
  assert.deepEqual((await within("zebra", 1)).value.results.map((r) => r.path), ["Public/Decoy.md"]);
  // From the query string, the globs come as JSON.
  const fromUrl = (await runOperation("search", { query: "zebra", zone: "UTC", within: '["Public/**"]' }, store, ada)) as { ok: true; value: { total: number } };
  assert.equal(fromUrl.value.total, 1);
  assert.equal((await runOperation("search", { query: "zebra", zone: "UTC", within: "Public/**" }, store, ada)).ok, false);
});
