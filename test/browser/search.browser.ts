// Search, in a real browser against the real Worker: ⌘K finds notes by their words and tasks and events
// in their own sections, Tab completes filters, and on a phone it fills the screen, with chips that write
// filters into the query.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const bar = (page: Page) => page.locator("#command-bar");
const field = (page: Page) => page.locator("#command-bar input");
/** The rows on show once the query's answers are in, section headings in capitals. */
async function rows(page: Page): Promise<string[]> {
  await page.locator("#command-bar ul:not([aria-busy])").waitFor({ state: "attached" });
  return page.locator("#command-bar li").evaluateAll((lis) => lis.map((li) => (li.classList.contains("section") ? li.textContent!.toUpperCase() : li.querySelector(".label")!.textContent!)));
}
const title = (page: Page, note: string) => page.waitForFunction((note) => document.title === `${note} · Common Ink`, note);

browserTest(h, "⌘K finds notes by their words, then tasks and events, and Tab completes a filter", { scenario: "preview", open: "Welcome" }, async ({ page }) => {
  await title(page, "Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await bar(page).waitFor();
  assert.equal((await rows(page))[0], "RECENT", "with nothing typed, the notes changed last");
  await field(page).pressSequentially("pay rent");
  const found = await rows(page);
  assert.equal(found[0], "NOTES");
  assert.ok(found.indexOf("Chores") < found.indexOf("TASKS") && found.indexOf("TASKS") < found.indexOf("Pay rent"), `the note, then the task: ${found.join(" | ")}`);

  await field(page).fill("garden fr");
  await page.keyboard.press("Tab");
  await page.keyboard.press("a");
  await page.keyboard.press("Tab");
  assert.equal(await field(page).inputValue(), "garden from:agent");
  assert.equal((await rows(page))[1], "Garden plan 2026", "the seed's notes are an agent's");
  await page.keyboard.press("Enter");
  await title(page, "Garden plan");
  assert.equal(await bar(page).isHidden(), true);
});

browserTest(h, "search follows notes as they're written, and says who wrote them", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.call("idle");
  await page.evaluate(() => fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "Zoo/Zebra facts.md", text: "# Zebra facts\nStripes, mostly.", base: 0 }) }));
  await page.keyboard.press("ControlOrMeta+k");
  await field(page).fill("stripe from:me in:zoo");
  assert.deepEqual(await rows(page), ["NOTES", "Zebra facts"]);
  await field(page).fill("stripe from:agent");
  assert.deepEqual(await rows(page), []);
});

browserTest(h, "on a phone, search fills the screen, and a chip writes its filter into the query", { scenario: "preview", open: "Welcome", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await title(page, "Welcome");
  await app.call("command", "Search…");
  await bar(page).waitFor();
  const box = await bar(page).boundingBox();
  assert.deepEqual(box && [box.x, box.y, box.width, box.height], [0, 0, 375, 812], "the whole screen");
  await field(page).fill("pay");
  assert.ok((await rows(page)).includes("EVENTS"));
  await page.locator("#command-bar .chips button", { hasText: "Tasks" }).tap();
  assert.equal(await field(page).inputValue(), "pay type:task ");
  assert.deepEqual(await rows(page), ["TASKS", "Pay rent"]);
  assert.equal(await page.locator("#command-bar .chips button", { hasText: "Tasks" }).getAttribute("aria-pressed"), "true");
  await page.locator("#command-bar li", { hasText: "Pay rent" }).tap();
  await title(page, "Chores");
  assert.equal(await bar(page).isHidden(), true);

  await app.call("command", "Search…");
  await page.locator("#command-bar .cancel").tap();
  assert.equal(await bar(page).isHidden(), true, "Cancel closes it");
});
