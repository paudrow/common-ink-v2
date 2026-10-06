import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "../web/src/extensions/words/count.ts";

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
