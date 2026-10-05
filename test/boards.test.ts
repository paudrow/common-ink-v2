import assert from "node:assert/strict";
import { test } from "node:test";
// The Boards extension from the app's catalog: plain JavaScript, as it's installed.
const B = await import(String("../web/public/catalog/boards/index.js"));

const NOTES = [
  { path: "Projects/Garden.md", text: "# Garden\n- [ ] Order seeds due:2026-10-03\n- [x] Dig the bed\n```\n- [ ] not a todo, in code\n```\n- [ ] Water due:2099-01-01" },
  { path: "Projects/Bike.md", text: "- [ ] Fix the brakes\n  - [ ] Buy pads" },
  { path: "Journal/2026-10-04.md", text: "- [ ] Call mum due:2026-10-04" },
];

test("a task list gathers open todos from the notes it asks for, soonest due first", () => {
  const titles = (args: Record<string, string>) => B.query(NOTES, args).map((t: { title: string }) => t.title);
  assert.deepEqual(titles({ folder: "Projects" }), ["Order seeds", "Water", "Fix the brakes", "Buy pads"], "code blocks hold no todos; done ones are left out");
  assert.deepEqual(titles({ due: "any" }), ["Order seeds", "Call mum", "Water"]);
  assert.deepEqual(titles({ note: "Projects/Bike", q: "pads" }), ["Buy pads"]);
  assert.deepEqual(titles({ folder: "Projects", done: "true", limit: "2" }), ["Order seeds", "Water"]);
  const [first] = B.query(NOTES, { folder: "Projects" });
  assert.deepEqual([first.path, first.line, first.due], ["Projects/Garden.md", 1, "2026-10-03"], "each knows its line, to be checked off there");
});

test("checking off a todo checks it; a recurring one moves to its next date, as Todos does", () => {
  assert.equal(B.toggle("- [ ] Pay rent", "2026-10-04"), "- [x] Pay rent");
  assert.equal(B.toggle("  - [x] Done", "2026-10-04"), "  - [ ] Done");
  assert.equal(B.toggle("- [ ] Recycling due:2026-10-03 every:week", "2026-10-04"), "- [ ] Recycling due:2026-10-10 every:week");
  assert.equal(B.toggle("- [ ] Rent due:2026-01-31 every:month", "2026-10-04"), "- [ ] Rent due:2026-02-28 every:month");
  assert.equal(B.toggle("- [ ] Water every:3days", "2026-10-04"), "- [ ] Water every:3days due:2026-10-07");
});

const BOARD = "## Todo\n- Outline\n- Venue\n\n## Doing\n- Slides\n  with notes\n\n## Done\n";

test("a board is its block's markdown; moving a card rewrites just that, keeping everything else", () => {
  const board = B.parseBoard(BOARD);
  assert.deepEqual(board.map((c: { name: string; items: Array<{ card: boolean; text: string }> }) => [c.name, c.items.filter((i) => i.card).map((i) => i.text)]), [
    ["Todo", ["Outline", "Venue"]],
    ["Doing", ["Slides"]],
    ["Done", []],
  ]);
  assert.equal(B.boardText(board), BOARD, "it reads back exactly");
  assert.equal(B.boardText(B.moveCard(board, { column: 0, index: 1 }, { column: 1, index: 0 })), "## Todo\n- Outline\n\n## Doing\n- Venue\n- Slides\n  with notes\n\n## Done\n");
  assert.equal(B.boardText(B.moveCard(board, { column: 1, index: 0 }, { column: 2, index: 0 })), "## Todo\n- Outline\n- Venue\n\n## Doing\n\n## Done\n- Slides\n  with notes\n", "a card's indented lines go with it");
  assert.equal(B.boardText(B.moveCard(board, { column: 0, index: 0 }, { column: 0, index: 2 })), "## Todo\n- Venue\n- Outline\n\n## Doing\n- Slides\n  with notes\n\n## Done\n");
});
