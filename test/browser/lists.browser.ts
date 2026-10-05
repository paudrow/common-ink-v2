// Lists in a real browser: Vim's > and < act on items with their children, as an outliner does, and
// the list draws with bullets, numbers and guides.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness } from "./harness.ts";

const h = harness();

const lines = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1300));
    const file = await fetch(`/api/file?path=${encodeURIComponent("Lists tour.md")}`).then((r) => r.json());
    return (file.text as string).split("\n").slice(4, 12);
  });

test("Vim's < and > move list items with their children, and ]e moves them past their siblings", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${h.base}/?file=${encodeURIComponent("Lists tour.md")}`);
  await page.waitForSelector(".cm-list-bullet");
  assert.ok((await page.locator(".cm-list-number").count()) >= 4, "numbers drawn in their column");
  await page.click(".cm-content");
  await page.keyboard.type("/Order seeds");
  await page.keyboard.press("Enter");
  await page.keyboard.type("<<");
  assert.deepEqual((await lines(page)).slice(0, 5), [
    "- Plan the garden",
    "  - Build the raised bed",
    "- Order seeds",
    "  - Tomatoes, the ones that did well last summer by the south fence, and a second variety to try",
    "  - Basil",
  ]);
  await page.keyboard.type(">>");
  assert.deepEqual((await lines(page)).slice(2, 4), ["  - Order seeds", "    - Tomatoes, the ones that did well last summer by the south fence, and a second variety to try"]);
  await page.keyboard.type("/Fix the");
  await page.keyboard.press("Enter");
  await page.keyboard.type("]e");
  assert.deepEqual((await lines(page)).slice(5, 8), ["- Call the plumber", "- Fix the bike", "  - Patch the inner tube"]);
  assert.deepEqual(errors, []);
  await page.close();
});

/** What's wrong with the page's todo chips and checkmarks: text spilling out of its box, or boxes over text or each other. */
const CHIP_PROBLEMS = `(() => {
  const textRects = (el) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()]; };
  const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  const apart = (a, b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
  const problems = [];
  for (const line of document.querySelectorAll(".cm-line")) {
    const chips = [...line.querySelectorAll(".todo-chip")];
    if (!chips.length) continue;
    const boxes = chips.map((c) => c.getBoundingClientRect());
    chips.forEach((c, i) => {
      if (!textRects(c).every((t) => inside(t, boxes[i]))) problems.push('"' + c.textContent + '" spills out of its chip');
      boxes.forEach((o, j) => { if (j > i && !apart(boxes[i], o)) problems.push('"' + c.textContent + '" overlaps "' + chips[j].textContent + '"'); });
    });
    const words = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = words.nextNode(); n; n = words.nextNode()) {
      if (n.parentElement.closest(".todo-chip, .todo-box") || !n.textContent.trim()) continue;
      for (const t of textRects(n)) boxes.forEach((b, i) => { if (!apart(t, b)) problems.push('"' + chips[i].textContent + '" overlaps "' + n.textContent + '"'); });
    }
  }
  for (const box of document.querySelectorAll('.todo-box[aria-checked="true"]')) {
    if (!textRects(box).every((t) => inside(t, box.getBoundingClientRect()))) problems.push("a checkmark sits outside its box");
  }
  return problems;
})()`;

test("a todo's chips and checkmark sit in their own boxes, clear of its text, wide and narrow", async () => {
  for (const width of [1100, 420]) {
    const page = await h.browser.newPage({ viewport: { width, height: 700 } });
    await page.goto(`${h.base}/?file=Chores.md`);
    await page.waitForSelector(".todo-chip");
    // Plain JavaScript, as a string: the test runner's TypeScript would name these functions with a helper the page doesn't have.
    const report = (await page.evaluate(CHIP_PROBLEMS)) as string[];
    assert.deepEqual(report, [], `at ${width}px`);
    await page.close();
  }
});
