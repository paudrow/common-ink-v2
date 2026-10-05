// The windows' chrome is the Workbench extension (ADR 0006): with it, tab bars, dragging, borders and
// the tab menu; without it (turned off, or failing), each window shows its tab on show, and the command
// bar, settings and the Extensions view still work.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, runCommand, writeFile } from "./harness.ts";

const h = harness();

const SETTINGS = ".common-ink/users/tester@localhost/settings.json";

async function open(page: Page, settings: Record<string, unknown>, file = "Welcome.md") {
  await page.goto(`${h.base}/?file=${encodeURIComponent(file)}`);
  await page.waitForSelector(".cm-content");
  await writeFile(page, SETTINGS, JSON.stringify(settings));
  await writeFile(page, ".common-ink/layout.json", "");
  await page.goto(`${h.base}/?file=${encodeURIComponent(file)}`);
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(400);
}

const windows = (page: Page) => page.evaluate(() => document.querySelectorAll(".group").length);

test("with Workbench, windows have tab bars; notes drag into windows to split them, and tabs have their menu", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, {});
  assert.deepEqual(await page.locator(".group .tab .name").allTextContents(), ["Welcome"]);
  // A note dropped on a window's right edge opens in a new window to its right.
  const editors = page.locator(".group .editors").first();
  const box = (await editors.boundingBox())!;
  await page.locator("#notes a", { hasText: "Chores" }).dragTo(editors, { targetPosition: { x: box.width - 10, y: box.height / 2 } });
  await page.waitForFunction(() => document.querySelectorAll(".group").length === 2);
  assert.equal(await page.locator(".resizer").count(), 1, "with a border between them to resize");
  assert.deepEqual(await page.locator(".group").nth(1).locator(".tab .name").allTextContents(), ["Chores"]);
  // The tab's menu: VSCode's items, each a command.
  await page.locator(".group").nth(1).locator(".tab").click({ button: "right" });
  await page.waitForSelector(".menu");
  const items = await page.locator(".menu button").allTextContents();
  assert.ok(items.some((t) => t.startsWith("Close Others")) && items.some((t) => t.startsWith("Split Right")), items.join(" | "));
  await page.keyboard.press("Escape");
  // Closing a window's only tab closes the window; the last window, emptied, says what to do.
  await runCommand(page, "Close tab");
  await page.waitForFunction(() => document.querySelectorAll(".group").length === 1);
  await runCommand(page, "Close tab");
  await page.waitForSelector(".window-empty dl");
  assert.match((await page.locator(".window-empty").textContent())!, /No note open.*Open note/s);
  assert.deepEqual(errors, []);
  await page.close();
});

test("without Workbench, each window shows its tab on show, and commands, settings and extensions are still there", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, { "extensions.disabled": ["workbench"] });
  assert.equal(await page.locator(".tabs").count(), 0, "no tab bar");
  assert.equal(await windows(page), 1);
  await page.locator("#notes a", { hasText: "Chores" }).click();
  await page.waitForFunction(() => document.title.startsWith("Chores"));
  assert.equal(await page.locator(".group .tab-editor:not([hidden])").count(), 1, "one view in the window");
  await runCommand(page, "Open user settings");
  await page.waitForSelector(".settings-editor");
  await runCommand(page, "Show extensions");
  await page.waitForSelector("#panel .extensions-view");
  assert.equal(await page.locator('.extension-row[data-extension="workbench"] input[type=checkbox]').isChecked(), false, "it's off");
  // Its commands aren't there, and saying so is all that happens.
  await runCommand(page, "Split right");
  assert.equal(await windows(page), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a Workbench that throws while drawing leaves the plain windows, and says it failed", async () => {
  const page = await h.browser.newPage();
  await page.goto(`${h.base}/?file=Welcome.md`);
  await page.waitForSelector(".cm-content");
  // A trusted copy in the workspace, in place of the built-in, whose tab bars throw.
  await writeFile(page, ".common-ink/extensions/workbench/extension.json", JSON.stringify({ name: "Workbench", permissions: { editor: { why: "Draw the windows" } } }));
  await writeFile(page, ".common-ink/extensions/workbench/index.js", 'export default { activate(ctx) { ctx.layout.chrome({ tabs() { throw new Error("broken tab bar"); } }); } };');
  await open(page, { "extensions.trusted": ["workbench"] });
  assert.equal(await page.locator(".tabs").count(), 0);
  await runCommand(page, "Show extensions");
  await page.waitForSelector("#panel .extensions-view");
  assert.match((await page.locator('.extension-row[data-extension="workbench"]').textContent())!, /Failed|Error/);
  // Its details say why.
  await page.locator('.extension-row[data-extension="workbench"] .extension-open').click();
  await page.waitForSelector(".extension-details .extension-error");
  assert.match((await page.locator(".extension-details .extension-error").textContent())!, /broken tab bar/);
  await runCommand(page, "Open note…");
  await page.waitForSelector("#command-bar:not([hidden])");
  await page.close();
});
