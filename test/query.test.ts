import assert from "node:assert/strict";
import { test } from "node:test";
import { format, matches, parse, problems, select, sortOf, titleOf, type NoteFacts } from "../worker/src/query.ts";

const NOW = Date.parse("2026-10-05T15:00:00Z");
const ctx = { now: NOW, zone: "America/New_York" };
const HOUR = 3_600_000;

const note = (over: Partial<NoteFacts>): NoteFacts => ({
  path: "Projects/Launch plan.md",
  title: "Launch plan",
  text: "# Launch plan\nShip the beta on Oct 20.\n- [ ] Record the demo",
  edited: NOW - HOUR,
  author: { kind: "user", email: "ada@example.com" },
  ...over,
});

test("a query reads as words, phrases and filters, each perhaps negated", () => {
  assert.deepEqual(parse('launch "beta date" -draft in:"My Projects/" -is:archived sort:edited').terms, [
    { kind: "words", text: "launch", negated: false },
    { kind: "words", text: "beta date", negated: false },
    { kind: "words", text: "draft", negated: true },
    { kind: "filter", key: "in", value: "My Projects/", negated: false },
    { kind: "filter", key: "is", value: "archived", negated: true },
    { kind: "filter", key: "sort", value: "edited", negated: false },
  ]);
});

test("a word with a colon is a filter only when its key is one the language or an extension knows", () => {
  assert.deepEqual(parse("http://example.com due:today").terms, [
    { kind: "words", text: "http://example.com", negated: false },
    { kind: "words", text: "due:today", negated: false },
  ]);
  assert.deepEqual(parse("due:today", ["due"]).terms, [{ kind: "filter", key: "due", value: "today", negated: false }]);
  assert.equal(format(parse('"is:archived" IS:pinned')), '"is:archived" is:pinned');
});

test("an open quote runs to the end, and a lone dash is a word", () => {
  assert.deepEqual(parse('- "beta da').terms, [
    { kind: "words", text: "-", negated: false },
    { kind: "words", text: "beta da", negated: false },
  ]);
  assert.equal(format(parse('- "beta da')), '"-" "beta da"');
});

test("words match whole words in the title and text, the last one as a prefix, without case or accents", () => {
  const n = note({ text: "# Launch plan\nRésumé of the beta date" });
  const hits = (q: string) => matches(parse(q), n, ctx);
  assert.equal(hits("laun"), true);
  assert.equal(hits("resume"), true);
  assert.equal(hits('"beta da"'), true);
  assert.equal(hits('"beta of"'), false);
  assert.equal(hits("aunch"), false);
  assert.equal(hits("-beta"), false);
  assert.equal(hits("launch -draft"), true);
});

test("filters test a note's state, folder, author, age and contents", () => {
  const agentEdit = note({ author: { kind: "agent", name: "Claude", by: "ada@example.com" }, archived: true });
  assert.deepEqual(
    ["is:archived", "-is:archived", "in:projects", "in:Proj", "from:agent", "from:claude", "from:me", "type:note", "type:event", "has:task", "has:embed"].map((q) => matches(parse(q), agentEdit, ctx)),
    [true, false, true, false, true, true, false, true, false, true, false],
  );
});

test("several of a filter that takes any pass on one; a filter notes don't have never matches", () => {
  const n = note({});
  assert.equal(matches(parse("in:Journal in:Projects"), n, ctx), true);
  assert.equal(matches(parse("in:Projects -in:Journal"), n, ctx), true);
  assert.equal(matches(parse("in:Journal in:Projects -in:projects/"), n, ctx), false);
  assert.equal(matches(parse("is:pinned is:archived"), note({ pinned: true }), ctx), false);
  assert.equal(matches(parse("due:today", ["due"]), n, ctx), false);
  assert.equal(matches(parse("-due:today", ["due"]), n, ctx), false);
  assert.equal(matches(parse("is:open"), n, ctx), false);
});

test("edited: counts days where the person is, and ages back from now", () => {
  // 01:00 on Oct 5 in UTC is still Oct 4 in New York.
  const lateLastNight = note({ edited: Date.parse("2026-10-05T01:00:00Z") });
  assert.deepEqual(
    ["edited:today", "edited:yesterday", "edited:2026-10-04", "edited:<2026-10-05", "edited:>=2026-10-04", "edited:<1d", "edited:>2d"].map((q) => matches(parse(q), lateLastNight, ctx)),
    [false, true, true, true, true, true, false],
  );
  assert.equal(matches(parse("edited:>90d"), note({ edited: NOW - 100 * 86_400_000 }), ctx), true);
});

test("Trash is searched only when asked, and a filter still being typed is left out", () => {
  const trashed = note({ trashed: true });
  assert.equal(matches(parse("launch"), trashed, ctx), false);
  assert.equal(matches(parse("launch is:trashed"), trashed, ctx), true);
  assert.equal(matches(parse("launch is:"), note({}), ctx), true);
});

test("problems say which values a filter doesn't take", () => {
  assert.deepEqual(problems(parse("is:shiny edited:soon -sort:title in: from:me")), [
    "is: is one of archived, pinned, trashed, open, done",
    "edited: is today, yesterday, a day like 2026-10-05 (after <, <=, > or >=), or an age like <7d or >3m",
    "sort: can't be negated",
  ]);
});

test("results put title matches first, then the newest, with archived notes last", () => {
  const notes = [
    note({ path: "a.md", title: "Groceries", text: "launch party snacks", edited: NOW - 1 * HOUR }),
    note({ path: "b.md", title: "Launch plan", text: "", edited: NOW - 5 * HOUR }),
    note({ path: "c.md", title: "Launch retro", text: "", edited: NOW - 2 * HOUR, archived: true }),
    note({ path: "d.md", title: "Old launch", text: "", edited: NOW - 9 * HOUR }),
    note({ path: "e.md", title: "Unrelated", text: "nothing here", edited: NOW }),
  ];
  assert.deepEqual(select(parse("launch"), notes, ctx).map((n) => n.path), ["b.md", "d.md", "a.md", "c.md"]);
  assert.deepEqual(select(parse("launch sort:edited"), notes, ctx).map((n) => n.path), ["a.md", "b.md", "d.md", "c.md"]);
  assert.deepEqual(select(parse("-is:archived sort:title"), notes, ctx).map((n) => n.path), ["a.md", "b.md", "d.md", "e.md"]);
});

test("the order is relevance with words to rank by, edited without", () => {
  assert.deepEqual([sortOf(parse("launch")), sortOf(parse("-is:archived")), sortOf(parse("launch sort:title")), sortOf(parse("-launch"))], ["relevance", "edited", "title", "edited"]);
});

test("a note's title is its first heading, or its file name", () => {
  assert.deepEqual([titleOf("A/b.md", "intro\n# Plan ##\n# Later"), titleOf("A/Reading list.md", "no heading")], ["Plan", "Reading list"]);
});

test("a note's title is read in linear time, however its heading line is padded", () => {
  const start = performance.now();
  for (const line of [`# a${" ".repeat(20_000)}b`, `# a${" #".repeat(20_000)}b`, `#${" ".repeat(20_000)}`]) titleOf("x.md", `${line}\n`);
  assert.ok(performance.now() - start < 50, `took ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual([titleOf("x.md", "#   Plan  ##  \n"), titleOf("x.md", "# C# notes\n"), titleOf("x.md", "#\n# Real"), titleOf("a/Name.md", "#hashtag\n")], ["Plan", "C# notes", "Real", "Name"]);
});

test("words match by their letters in every script: accents fold where they're optional, and nowhere else", () => {
  const n = (text: string) => note({ title: "", text });
  const hits = (q: string, text: string) => matches(parse(q), n(text), ctx);
  assert.deepEqual(
    [
      hits("cafe", "café"),
      hits("cafe", "café"),
      hits("αλφα", "Άλφα"),
      hits("istanbul", "İstanbul"),
      hits("שלום", "שָׁלוֹם"),
      hits("كتب", "كَتَبَ"),
      hits("한국", "한국 여행"),
      hits("мой", "мой план"),
      hits("мои", "мой план"),
      hits("がっこう", "がっこう"),
      hits("かっこう", "がっこう"),
      hits("पठ", "हिन्दी पाठ"),
      hits("पाठ", "हिन्दी पाठ"),
    ],
    [true, true, true, true, true, true, true, true, false, true, false, false, true],
  );
});

test("a negated sort: is a problem, and doesn't empty the list", () => {
  assert.equal(matches(parse("-sort:edited"), note({}), ctx), true);
  assert.deepEqual(problems(parse("-sort:edited")), ["sort: can't be negated"]);
});

test("has:task reads a note of many blank lines in linear time", () => {
  const start = performance.now();
  assert.equal(matches(parse("has:task"), note({ text: `${"\n".repeat(50_000)}x` }), ctx), false);
  assert.ok(performance.now() - start < 50, `took ${Math.round(performance.now() - start)} ms`);
});

test("a negated sort asks for no order", () => {
  assert.deepEqual([sortOf(parse("launch -sort:title")), sortOf(parse("-sort:title")), sortOf(parse("sort:title -sort:edited"))], ["relevance", "edited", "title"]);
});
