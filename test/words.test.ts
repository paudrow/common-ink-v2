import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeSet, Text } from "@codemirror/state";
import { countWords, WordTally } from "../web/src/extensions/words/count.ts";

test("words are counted as a reader counts them, without markdown's marks", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("# Launch plan\n\nShip the beta on Oct 20."), 8);
  assert.equal(countWords("Don't stop: it's well-known."), 5);
  assert.equal(countWords("- Plan the garden\n  - Order seeds\n1. Preheat the oven\n10) Mix"), 9);
  assert.equal(countWords("- [ ] Record the demo\n- [x] Draft it\n> quoted words"), 7);
  assert.equal(countWords("**Bold** and _italic_ and `code`"), 5);
});

test("a link counts its words, and an address is one word", () => {
  assert.equal(countWords("See [the roadmap](https://example.com/road-map?x=1) now"), 4);
  assert.equal(countWords("Read https://example.com/a/b-c today"), 3);
});

test("numbers count, and so does text without spaces between its words", () => {
  assert.equal(countWords("It costs 1,250.50 in 2026"), 5);
  assert.equal(countWords("東京に行きます"), 4);
});

test("code, math, diagrams and widget lines aren't words; the prose around them is", () => {
  assert.equal(countWords("Before it\n```js\nconst a = b + c;\n```\nafter it"), 4);
  assert.equal(countWords("One\n````md\n```\nstill code\n```\n````\ntwo"), 2);
  assert.equal(countWords("~~~mermaid\nflowchart LR\n  A --> B\n~~~\nA diagram"), 2);
  assert.equal(countWords("The sum\n$$\nx = \\frac{a}{b}\n$$\n$$ y = 2 $$\nis small"), 4);
  assert.equal(countWords("::timer{duration=25m label=\"Focus\"}\n:::kanban\n## Doing\n- Write the plan\n:::\nDone"), 5);
  assert.equal(countWords("An unclosed fence\n```\nhides the rest"), 3);
});

test("HTML tags and their attributes aren't words, the text in them is", () => {
  assert.equal(countWords('<p class="lead">Hello <b>big</b> world</p><br/>'), 3);
  assert.equal(countWords('<img src="a.png" alt="A cat"> <!-- a note to self --> seen'), 1);
});

const edit = (tally: WordTally, from: number, to: number, insert: string) => {
  const changes = ChangeSet.of({ from, to, insert }, tally.doc.length);
  return tally.update(changes, changes.apply(tally.doc));
};

test("a one-letter edit to a 20,000-line note reads that line again, and no other", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => (i % 10 === 0 ? `## Heading ${i}` : `The quick brown fox jumps over the dog, line ${i}.`));
  const tally = new WordTally(Text.of(lines));
  assert.equal(tally.total, 184_000);
  const at = tally.doc.line(10_001).from;
  assert.equal(edit(tally, at, at, "a "), 1);
  assert.equal(tally.total, 184_000 + 1);
  assert.equal(edit(tally, at, at + 2, ""), 1);
  assert.equal(tally.total, 184_000);
  const end = tally.doc.line(15_000).to;
  assert.equal(edit(tally, end, end, "\nTwo more"), 2);
  assert.equal(tally.total, 184_000 + 2);
});

test("a code block typed in reads only its own lines; one left open reads on to the end", () => {
  const tally = new WordTally(Text.of(["one", "two", "three", "four"]));
  assert.equal(edit(tally, tally.doc.line(2).from, tally.doc.line(2).from, "```\ncode\n```\n"), 4);
  assert.equal(tally.total, 4);
  assert.equal(edit(tally, tally.doc.line(4).from, tally.doc.line(5).from, ""), 3);
  assert.equal(tally.doc.toString(), "one\n```\ncode\ntwo\nthree\nfour");
  assert.equal(tally.total, 1);
});

test("edits anywhere, of any size, leave the same count as counting the note afresh", async () => {
  const { forAll } = await import("./property/gen.ts");
  const pieces = ["word", "two words", "\n", "\n```\n", "```js", "\n~~~\n", "$$", "\n$$\n", "<b>", "</b>", "::timer{d=1m}", "\n:::kanban\n", ":::", "- [ ] ", "[a](https://x.y)", "東京", "  ", ""];
  forAll(
    (r) => ({
      start: r.array(0, 30, (r) => r.pick(pieces)).join(""),
      edits: r.array(1, 12, (r) => ({ at: r.next(), len: r.int(0, 12), insert: r.array(0, 3, (r) => r.pick(pieces)).join(""), also: r.bool(0.3) })),
    }),
    ({ start, edits }) => {
      const tally = new WordTally(Text.of(start.split("\n")));
      for (const e of edits) {
        const n = tally.doc.length;
        const from = Math.floor(e.at * n);
        const spec = [{ from, to: Math.min(n, from + e.len), insert: e.insert }];
        // Sometimes a second change further on, as several cursors or a merged-in edit make.
        if (e.also && from + e.len + 2 <= n) spec.push({ from: n - 1, to: n, insert: e.insert });
        const changes = ChangeSet.of(spec, n);
        tally.update(changes, changes.apply(tally.doc));
        assert.equal(tally.total, countWords(tally.doc.toString()), JSON.stringify(tally.doc.toString()));
      }
    },
    { runs: 300 },
  );
});
