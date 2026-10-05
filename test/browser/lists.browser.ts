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
