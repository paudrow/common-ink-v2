import assert from "node:assert/strict";
import { test } from "node:test";
import { dateGroup, previewLines } from "../web/src/extensions/feed/cards.ts";

test("a card's preview leaves out the title, blank lines and marks, and says what each line is", () => {
  const text = "# Trip\n\nPack **light**, see [[Packing list|the list]] and [map](https://x.example).\n\n## Days\n- [ ] Book the train due:2026-10-09\n- [x] Passport\n- Socks\n1. First\n---\n> A quote\n";
  assert.deepEqual(previewLines(text, 8), [
    { kind: "text", text: "Pack light, see the list and map." },
    { kind: "heading", text: "Days" },
    { kind: "task", text: "Book the train due:2026-10-09" },
    { kind: "done", text: "Passport" },
    { kind: "item", text: "Socks" },
    { kind: "item", text: "First" },
    { kind: "text", text: "A quote" },
  ]);
  assert.equal(previewLines(text, 2).length, 2);
});

test("an embed in a card is one quiet line naming it, never its body", () => {
  const text = '# Focus\n::timer{duration=25m label="Deep work"}\n:::kanban\n## To do\n- a\n:::\n```js\nlet secret = 1\n```\n```\nplain\n```\nAfter';
  assert.deepEqual(previewLines(text), [
    { kind: "embed", text: "Timer · 25m · Deep work" },
    { kind: "embed", text: "Kanban" },
    { kind: "embed", text: "Js" },
    { kind: "embed", text: "Code" },
    { kind: "text", text: "After" },
  ]);
});

test("cards are grouped by the day of their last change: Today, Yesterday, This week, This month, then by month", () => {
  const now = new Date(2026, 9, 20, 10).getTime();
  const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime();
  assert.deepEqual(
    [at(9, 20, 1), at(9, 19, 23), at(9, 15), at(9, 2), at(8, 30), at(0, 5)].map((t) => dateGroup(t, now)),
    ["Today", "Yesterday", "This week", "This month", "September 2026", "January 2026"],
  );
});
