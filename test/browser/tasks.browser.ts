// Tasks in a real browser against the real Worker: chips sit clear of a task's words and of each other,
// a chip's editor changes just its token, a ::tasks list ticks a task in its note, and the Tasks view
// puts what's overdue or due today at the top. Each runs on the tasks scenario, whose clock is 9:00 on
// Monday 2026-10-05, so "today" never depends on when or where the tests run.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness, runCommand } from "./harness.ts";

const h = harness();
const TASKS = { scenario: "tasks", open: "Chores.md" };

const note = (page: Page, path: string): Promise<{ text: string }> => page.evaluate((path) => fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => r.json()), path);

/** Wait until a note's text passes `test`, asking the server every quarter second. */
async function until(page: Page, path: string, test: (text: string) => boolean) {
  for (let tries = 0; tries < 60; tries++) {
    if (test((await note(page, path)).text)) return;
    await page.waitForTimeout(250);
  }
  assert.fail(`${path} never changed as expected:\n${(await note(page, path)).text}`);
}

/** What's wrong with the page's task chips and checkmarks: text spilling out of its chip, chips over text or each other, a tick with no mark. */
const CHIP_PROBLEMS = `(() => {
  const textRects = (el) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()]; };
  const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  const apart = (a, b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
  const problems = [];
  for (const line of document.querySelectorAll(".cm-line")) {
    const chips = [...line.querySelectorAll(".tk")];
    if (!chips.length) continue;
    const boxes = chips.map((c) => c.getBoundingClientRect());
    chips.forEach((c, i) => {
      if (!textRects(c).every((t) => inside(t, boxes[i]))) problems.push('"' + c.textContent + '" spills out of its chip');
      boxes.forEach((o, j) => { if (j > i && !apart(boxes[i], o)) problems.push('"' + c.textContent + '" overlaps "' + chips[j].textContent + '"'); });
    });
    const words = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = words.nextNode(); n; n = words.nextNode()) {
      if (n.parentElement.closest(".tk, .cm-checkbox") || !n.textContent.trim()) continue;
      for (const t of textRects(n)) boxes.forEach((b, i) => { if (!apart(t, b)) problems.push('"' + chips[i].textContent + '" overlaps "' + n.textContent + '"'); });
    }
  }
  for (const box of document.querySelectorAll('.cm-checkbox[aria-checked="true"]')) {
    if (!getComputedStyle(box).backgroundImage.includes("svg")) problems.push("a ticked box has no checkmark");
  }
  return problems;
})()`;

for (const width of [1100, 420]) {
  browserTest(h, `a task's chips and checkmark sit in their own boxes, clear of its words, at ${width}px`, { ...TASKS, viewport: { width, height: 800 } }, async ({ page }) => {
    await page.waitForSelector(".cm-line .tk");
    // Plain JavaScript, as a string: the test runner's TypeScript would name these functions with a helper the page doesn't have.
    const report = (await page.evaluate(CHIP_PROBLEMS)) as string[];
    assert.deepEqual(report, []);
  });
}

browserTest(h, "a chip opens its own editor, and a pick rewrites just that token in the note", { ...TASKS, viewport: { width: 1100, height: 800 } }, async ({ page }) => {
  const rent = page.locator(".cm-line", { hasText: "Pay rent" });
  await rent.locator('.tk[data-field="priority"]').click();
  await page.locator(".chip-pop .fp-item", { hasText: "Low" }).click();
  await until(page, "Chores.md", (text) => /- \[ \] Pay rent due:\S+ rec:1st @sam !low #home\/bills/.test(text));
  assert.equal(await page.locator(".chip-pop").count(), 0, "the editor closes");
  // The repeat's editor: More options… shows the whole rule, with the next dates it gives.
  await rent.locator('.tk[data-field="rec"]').click();
  await page.locator(".chip-pop .fp-item", { hasText: "More options" }).click();
  assert.match((await page.textContent(".chip-rec-summary"))!, /^Every month on the 1st/);
  assert.match((await page.textContent(".chip-rec-dates"))!, /^After this one:/);
  await page.keyboard.press("Escape");
});

browserTest(h, "a ::tasks list ticks a task in its note; a repeating one moves on to its next date", { ...TASKS, open: "Tasks tour.md", viewport: { width: 1100, height: 1000 } }, async ({ page }) => {
  const list = page.locator('.cm-embed[data-embed="tasks"]').first();
  const row = list.locator(".qt-row", { hasText: "Plan the offsite" });
  await row.waitFor();
  await row.locator(".cm-checkbox").click();
  await until(page, "Tasks tour.md", (text) => /- \[x\] Plan the offsite with @sam due:\S+ #work done:\d{4}-\d{2}-\d{2}/.test(text));
  const invoice = list.locator(".qt-row", { hasText: "Send the Q4 invoice" });
  const before = /Send the Q4 invoice to Acme due:(\S+)/.exec((await note(page, "Tasks tour.md")).text)![1];
  await invoice.locator(".cm-checkbox").click();
  await until(page, "Tasks tour.md", (text) => {
    const due = /- \[ \] Send the Q4 invoice to Acme due:(\S+) rec:monthly/.exec(text)?.[1];
    return !!due && due > before;
  });
});

browserTest(h, "Show tasks puts what's overdue and due today at the top, then the rest", { ...TASKS, viewport: { width: 1200, height: 900 } }, async ({ page }) => {
  await page.waitForSelector(".cm-line .tk");
  await runCommand(page, "Show tasks");
  const today = page.locator(".td-block");
  await today.locator(".qt-row").first().waitFor();
  assert.ok(await today.locator(".td-section.is-overdue .qt-row", { hasText: "Take out the recycling" }).count());
  assert.ok(await today.locator(".td-section.is-due .qt-row", { hasText: "Water the plants" }).count());
  // Below it, the rest, not again what Today has.
  const rest = page.locator(".tasks-view .qt-list");
  await rest.locator(".qt-row", { hasText: "Pay rent" }).waitFor();
  assert.equal(await rest.locator(".qt-row", { hasText: "Water the plants" }).count(), 0);
});

browserTest(h, "⌘⇧. opens quick-add from a note, Dvorak's key included; Enter adds the task, read from words, to today's note", { ...TASKS, viewport: { width: 1100, height: 800 } }, async ({ page }) => {
  await page.waitForSelector(".cm-line .tk");
  await page.locator(".cm-line", { hasText: "Chores" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await page.waitForSelector(".qa-float .cm-content");
  // (A tag typed last opens its suggestions, whose Enter picks one: the tag goes first here.)
  await page.keyboard.type("Pay the gas bill #home every month on the 1st");
  assert.equal(await page.textContent(".qa-float .qa-hl"), "every month on the 1st");
  assert.ok(await page.locator('.qa-float .qa-preview .tk[data-field="rec"]').count(), "the repeat's chip, before it's added");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".qa-float", { state: "detached" });
  await until(page, "Journal/2026-10-05.md", (text) => /## Tasks\n\n- \[ \] Pay the gas bill due:2026-11-01 rec:1st #home/.test(text));

  // On Dvorak, "." is the physical E key: the shortcut is the character, wherever it is, and with Shift the browser may say ">".
  await page.locator(".cm-line", { hasText: "Chores" }).click();
  await page.evaluate((mac) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ">", code: "KeyE", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true }));
  }, process.platform === "darwin");
  await page.waitForSelector(".qa-float .cm-content");
  // It types with the note's Vim keys: the first Esc is Vim's, to normal mode; the second leaves.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".qa-float", { state: "detached" });
});

browserTest(h, "on a task line, Tab right after a phrase makes it a token, and it's in the command list as Add a task", { ...TASKS, viewport: { width: 1100, height: 800 } }, async ({ page }) => {
  await page.waitForSelector(".cm-line .tk");
  // To the end of Ask's line with Vim, not a click (that could land on a chip and open its editor).
  await page.locator(".cm-line", { hasText: "Chores" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("/Ask");
  await page.keyboard.press("Enter");
  await page.keyboard.press("A");
  await page.keyboard.type(" tomorrow");
  assert.equal(await page.textContent(".cm-phrase"), "tomorrow");
  await page.keyboard.press("Tab");
  await until(page, "Chores.md", (text) => /- \[ \] Ask @jane about the #garden plan !low due:2026-10-06\n/.test(text));
  await page.keyboard.press("Escape");
  await runCommand(page, "Add a task");
  await page.waitForSelector(".qa-float .cm-content");
});
