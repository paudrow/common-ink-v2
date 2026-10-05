// Going back and forward, in a real browser against the real Worker: the browser's own Back and Forward
// (here, page.goBack and goForward, as its buttons do) move through the notes you opened, a reload
// keeps the place, the app's ⌘[ and ⌘] agree with the browser, and moving the cursor about adds nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness } from "./harness.ts";

const h = harness();

/** The note on show, by the page's title. */
const showing = (page: Page) => page.evaluate(() => document.title.replace(/ · Common Ink$/, ""));
const until = (page: Page, title: string) => page.waitForFunction((title) => document.title === `${title} · Common Ink`, title);

test("the browser's Back and Forward go through the notes you opened; a reload keeps the place; ⌘[ agrees", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${h.base}/?file=Welcome.md`);
  await until(page, "Welcome");
  const entries = () => page.evaluate(() => history.length);
  const start = await entries();
  await page.locator("#notes a", { hasText: "Chores" }).click();
  await until(page, "Chores");
  await page.locator("#notes a", { hasText: "Shopping" }).click();
  await until(page, "Shopping");
  assert.equal(await entries(), start + 2, "a browser entry for each note opened");
  // Moving the cursor about isn't a place: no entries for it.
  await page.locator(".cm-content:visible").first().click();
  await page.keyboard.press("Escape");
  for (const key of ["j", "j", "k", "l", "w"]) await page.keyboard.press(key);
  await page.waitForTimeout(600);
  assert.equal(await entries(), start + 2);

  await page.goBack();
  await until(page, "Chores");
  assert.match(page.url(), /file=Chores\.md/);
  await page.goBack();
  await until(page, "Welcome");
  await page.goForward();
  await until(page, "Chores");

  // A reload keeps where you are, and what's behind and ahead of it.
  await page.reload();
  await until(page, "Chores");
  await page.goForward();
  await until(page, "Shopping");
  await page.goBack();
  await until(page, "Chores");

  // The app's own Go back and Go forward move the browser too, so the two agree.
  await page.locator(".cm-content:visible").first().click();
  await page.keyboard.press("ControlOrMeta+[");
  await until(page, "Welcome");
  await page.keyboard.press("ControlOrMeta+]");
  await until(page, "Chores");
  await page.goForward();
  await until(page, "Shopping");
  assert.equal(await showing(page), "Shopping");
  await page.close();
});
