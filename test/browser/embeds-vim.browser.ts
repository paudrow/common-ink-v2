// j and k with Vim over every kind of embed, in a real browser against the real Worker: a leaf directive,
// a fenced webview, a container, a link embed and a sandboxed task list. Each step goes to the next line,
// and a step onto an embed lands on its first line, showing its markdown: none is jumped over.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, writeFile } from "./harness.ts";

const h = harness();

const NOTE = [
  "# Every kind",
  "",
  "::timer{duration=5m}",
  "",
  "```html-app height=120",
  "<p>hi</p>",
  "```",
  "",
  ":::kanban",
  "## To do",
  "- Card",
  ":::",
  "",
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "",
  "::tasks{limit=3}",
  "",
  "End",
].join("\n");

/** The line the cursor is on, by number, from the editor itself. */
const cursorLine = (page: Page) =>
  page.evaluate(`(async () => {
    const { EditorView } = await globalThis.__commonInkLibrary("@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  })()`) as Promise<number>;

/**
 * Wait until the note's height holds still: frames that size themselves (the task list, a video) have
 * settled. Vim's j and k move by what's drawn, so a frame still growing can carry them past a line.
 */
async function settled(page: Page) {
  let last = -1;
  for (let same = 0; same < 2; ) {
    await page.waitForTimeout(150);
    const height = await page.evaluate(() => document.querySelector(".cm-content")!.getBoundingClientRect().height);
    same = height === last ? same + 1 : 0;
    last = height;
  }
}

/** Which embeds are drawn now, by kind. */
const drawn = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-embed")].map((e) => e.dataset.embed ?? e.dataset.urlEmbed).join(" "));

test("j and k step onto and off every kind of embed, line by line, jumping none", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 1400 } });
  await page.goto(h.base);
  await page.waitForSelector(".cm-content");
  await writeFile(page, "Every kind.md", NOTE);
  await page.goto(`${h.base}/?file=${encodeURIComponent("Every kind.md")}`);
  // The task list reads notes, so Boards asks first.
  await page.waitForSelector(".dialog");
  await page.click("text=Allow this time");
  await page.waitForFunction(() => document.querySelectorAll(".cm-embed").length === 5);
  assert.equal(await drawn(page), "timer html-app kanban youtube tasks");
  await page.frameLocator('.cm-embed[data-embed="tasks"] iframe').locator("body").waitFor();
  await settled(page);
  await page.locator(".cm-line", { hasText: "Every kind" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  assert.equal(await cursorLine(page), 1);

  const down: number[] = [];
  for (let i = 0; i < 17; i++) {
    await page.keyboard.press("j");
    down.push(await cursorLine(page));
    await settled(page);
    // On an embed's first line, its markdown shows; the others are still drawn.
    if (down.at(-1) === 3) assert.equal(await drawn(page), "html-app kanban youtube tasks", "on the timer's line, the timer is its line");
    if (down.at(-1) === 14) assert.equal(await drawn(page), "timer html-app kanban tasks", "on the link's line, the link is its line");
  }
  assert.deepEqual(down, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], "every line, embeds included");
  assert.equal(await drawn(page), "timer html-app kanban youtube tasks", "off them, all are drawn again");

  const up: number[] = [];
  for (let i = 0; i < 17; i++) {
    await page.keyboard.press("k");
    up.push(await cursorLine(page));
    await settled(page);
  }
  assert.deepEqual(up, [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  await page.close();
});
