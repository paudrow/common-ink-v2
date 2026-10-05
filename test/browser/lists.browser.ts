// Lists in a real browser: Vim's > and < act on items with their children, as an outliner does, and
// the list draws with bullets, numbers and guides.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, writeFile } from "./harness.ts";

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

/** Where an item's words start on screen, and where the line starts: found by its text. */
const textX = (page: Page, words: string) =>
  page.evaluate((words) => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent!.includes(words))!;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(words);
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + 1);
      return { x: Math.round(r.getBoundingClientRect().left * 10) / 10, top: Math.round(line.getBoundingClientRect().top) };
    }
    return null;
  }, words);

test("an item's line doesn't move as the cursor comes onto it, its marker or its words; Vim motions cross the marker as on raw text", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(`${h.base}/?file=${encodeURIComponent("Lists tour.md")}`);
  await page.waitForSelector(".cm-list-number");
  await page.click(".cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  const away = { bake: await textX(page, "Bake for"), basil: await textX(page, "Basil") };
  // Onto "4. Bake for twenty minutes": on its words, then on its number.
  await page.keyboard.type("/Bake for");
  await page.keyboard.press("Enter");
  assert.deepEqual(await textX(page, "Bake for"), away.bake, "the cursor on its words: the line stays put");
  assert.equal(await page.locator(".cm-line", { hasText: "Bake for" }).locator(".cm-list-number").textContent(), "4.", "its number is still its number");
  await page.keyboard.press("0");
  assert.deepEqual(await textX(page, "Bake for"), away.bake, "the cursor on its number: the line stays put");
  // A nested bullet: on its marker, the bullet is its "-", in the same box; the words don't move.
  await page.keyboard.type("/Basil");
  await page.keyboard.press("Enter");
  assert.deepEqual(await textX(page, "Basil"), away.basil);
  await page.keyboard.press("^");
  assert.equal(await page.locator(".cm-line", { hasText: "Basil" }).locator(".cm-list-bullet.raw").textContent(), "-", "on the marker, the bullet is its -");
  assert.deepEqual(await textX(page, "Basil"), away.basil, "and the words are where they were");
  // Vim's w from the marker goes to the word, and x deletes what's under the cursor, as on raw text.
  await page.keyboard.press("w");
  await page.keyboard.press("x");
  const file = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1300));
    return (await fetch(`/api/file?path=${encodeURIComponent("Lists tour.md")}`).then((r) => r.json())).text as string;
  });
  assert.match(file, /^    - asil$/m, "w landed on the B");
  await page.keyboard.press("u");
  await page.close();
});

test("Alt-Right and Alt-Left indent and dedent a list item; off a list, the key is left alone", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(h.base);
  await page.waitForSelector(".cm-content");
  await writeFile(page, "Alt keys.md", "# Alt keys\n\nA paragraph first.\n\n- Fix the bike\n  - Patch the inner tube\n- Call the plumber\n");
  const text = () =>
    page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 1300));
      return ((await fetch(`/api/file?path=${encodeURIComponent("Alt keys.md")}`).then((r) => r.json())).text as string).split("\n").slice(4, 7);
    });
  await page.goto(`${h.base}/?file=${encodeURIComponent("Alt keys.md")}`);
  const item = page.locator(".cm-line:visible", { hasText: "Fix the bike" });
  await item.waitFor();
  // After the app's own key handler (also on window, in the capture phase), what it did with the key.
  await page.evaluate(() => window.addEventListener("keydown", (e) => ((window as unknown as { prevented: boolean }).prevented = e.defaultPrevented), { capture: true }));
  const prevented = () => page.evaluate(() => (window as unknown as { prevented: boolean }).prevented);
  await item.click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("/Call the plumber");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowRight");
  assert.deepEqual(await text(), ["- Fix the bike", "  - Patch the inner tube", "  - Call the plumber"], "under the item above, as its last child");
  assert.equal(await prevented(), true, "the key was the list's");
  await page.keyboard.press("Alt+ArrowLeft");
  assert.deepEqual(await text(), ["- Fix the bike", "  - Patch the inner tube", "- Call the plumber"]);
  // On the paragraph, it isn't a list's key.
  await page.keyboard.type("/A paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowRight");
  assert.equal(await prevented(), false, "declined: the editor gets the key as usual");
  await page.close();
});
