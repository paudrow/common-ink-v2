// Default extensions, in a real browser against the real Worker: Vim and Live preview are extensions now,
// and the app is the same with them on; with them off, the plain editor has standard keys and raw markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, runCommand, writeFile } from "./harness.ts";

const h = harness();

const SETTINGS = ".common-ink/users/tester@localhost/settings.json";

const mode = (page: Page) =>
  page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('[data-item="vim.mode"]');
    return item && !item.hidden ? item.textContent : null;
  });

const focusedWindow = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".group")].findIndex((g) => g.contains(document.activeElement)));

async function open(page: Page, settings: Record<string, unknown>) {
  await page.goto(`${h.base}/?file=Welcome.md`);
  await page.waitForSelector(".cm-content");
  await writeFile(page, SETTINGS, JSON.stringify(settings));
  await page.reload();
  await page.waitForSelector(".cm-content");
  // Built-ins that start with the app have started once the mode shows, or after a moment without Vim.
  await page.waitForTimeout(500);
}

test("Vim is an extension: its mode is in the status bar, and :e, :vs, Ctrl-W, gt, Ctrl-O and the settings editor work as before", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, {});
  assert.equal(await mode(page), "NORMAL");
  await page.click(".cm-content");
  await page.keyboard.press("i");
  assert.equal(await mode(page), "INSERT");
  await page.keyboard.press("Escape");
  assert.equal(await mode(page), "NORMAL");

  await page.keyboard.type(":vs");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".group").length === 2);
  await page.keyboard.press("Control+w");
  await page.keyboard.press("h");
  await page.waitForFunction(() => document.querySelectorAll(".group")[0].contains(document.activeElement));
  await page.keyboard.press("Control+w");
  await page.keyboard.press("l");
  await page.waitForFunction(() => document.querySelectorAll(".group")[1].contains(document.activeElement));
  assert.equal(await focusedWindow(page), 1);
  await page.keyboard.press("Control+w");
  await page.keyboard.press("o");
  await page.waitForFunction(() => document.querySelectorAll(".group").length === 1);

  await page.keyboard.type(":e Chores");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.title.startsWith("Chores"));
  await page.keyboard.press("Control+o");
  await page.waitForFunction(() => document.title.startsWith("Welcome"), null, { timeout: 3000 });
  await page.keyboard.press("Control+i");
  await page.waitForFunction(() => document.title.startsWith("Chores"), null, { timeout: 3000 });

  await page.keyboard.type(":tabe Welcome");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.title.startsWith("Welcome"));
  await page.keyboard.press("g");
  await page.keyboard.press("T");
  await page.waitForFunction(() => document.title.startsWith("Chores"));

  await runCommand(page, "Open user settings (JSON)");
  await page.waitForFunction(() => document.title.startsWith("User settings"));
  await page.waitForSelector(".group .tab-editor:not([hidden]) .cm-fat-cursor");
  assert.equal(await mode(page), "NORMAL", "settings files have Vim too");
  assert.deepEqual(errors, []);
  await page.close();
});

test("with Vim off, the editor has standard keys and no mode; with Live preview off, markdown is raw", async () => {
  const page = await h.browser.newPage();
  await open(page, { "extensions.disabled": ["vim", "live-preview"] });
  assert.equal(await mode(page), null);
  // Welcome's "**Try this PR**" shows its markers only when markdown is raw.
  const drawn = () => page.evaluate(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("**Try this PR**")));
  assert.equal(await drawn(), false, "markdown is raw: no live preview");
  const firstLine = () => page.evaluate(() => document.querySelector(".cm-line")!.textContent);
  await page.click(".cm-line");
  await page.keyboard.press("Home");
  await page.keyboard.type("ix");
  assert.match((await firstLine())!, /^ix/, "i types an i: no Vim");
  assert.equal(await page.$(".cm-fat-cursor"), null);
  await page.keyboard.press("ControlOrMeta+z");
  assert.doesNotMatch((await firstLine())!, /^ix/);
  await open(page, {});
  assert.equal(await drawn(), true, "both back on: markdown is drawn");
  await page.close();
});
