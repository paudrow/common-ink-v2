import assert from "node:assert/strict";
import { test } from "node:test";
// The Boards extension from the app's catalog: plain JavaScript, as it's installed.
const B = await import(String("../web/public/catalog/boards/index.js"));

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
