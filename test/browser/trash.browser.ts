// Trash, in a real browser against the real Worker: a deleted note is in Trash with its days left, a
// link to it says "In Trash · Restore", ↵ looks inside, and r (or a swipe right, on a phone) restores
// it with its history.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

async function deleteNote(app: App, path: string) {
  const res = await app.page.evaluate(async (path) => {
    const file = await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json();
    return (await fetch("/api/file", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, base: file.revision }) })).status;
  }, path);
  assert.equal(res, 200);
}

const exists = (page: Page, path: string) => page.evaluate(async (path) => (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).ok, path);
const rows = (page: Page) => page.locator(".trash-view .trash-row");

browserTest(h, "a deleted note is in Trash, a link to it says so, and r restores it with its history", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Untitled 3.md", "# Untitled 3\nscratch thoughts");
  await app.writeFile("Index.md", "# Index\nSee [[Untitled 3]] for more.");
  await deleteNote(app, "Untitled 3.md");
  await app.open("Index");
  await page.locator(".trash-link", { hasText: "In Trash" }).waitFor();

  await app.command("Open trash");
  await rows(page).first().waitFor();
  assert.deepEqual(await rows(page).locator(".trash-title").allTextContents(), ["Untitled 3"]);
  assert.match((await rows(page).locator(".trash-left").textContent()) ?? "", /^30 days$/);
  await page.locator(".trash-view").focus();
  await page.keyboard.press("Enter");
  await page.locator(".trash-peek", { hasText: "scratch thoughts" }).waitFor();
  await page.keyboard.press("r");
  await page.locator(".trash-empty").waitFor();
  assert.equal(await exists(page, "Untitled 3.md"), true);
  assert.match((await page.locator(".notice").textContent()) ?? "", /Restored "Untitled 3" to Untitled 3\.md, with its history/);
  const history = await page.evaluate(async () => ((await (await fetch("/api/history?path=Untitled%203.md")).json()) as Array<{ deleted?: true; undoes: number | null }>).map((c) => (c.deleted ? "delete" : c.undoes ? "restore" : "write")));
  assert.deepEqual(history, ["restore", "delete", "write"]);

  await app.open("Index");
  await page.locator(".trash-link").waitFor({ state: "detached" });
});

browserTest(h, "on a phone, a swipe right restores a note from Trash", { scenario: "empty", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await app.writeFile("Groceries.md", "# Groceries\nEggs");
  await deleteNote(app, "Groceries.md");
  await app.command("Open trash");
  const row = rows(page).first();
  await row.waitFor();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const at = (x: number) => [{ x, y }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(40) });
  for (let x = 60; x <= 300; x += 30) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x) });
  assert.match((await row.getAttribute("data-swipe")) ?? "", /restore armed/, "green, and ready to restore");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.locator(".trash-empty").waitFor();
  assert.equal(await exists(page, "Groceries.md"), true);
});

browserTest(h, ":trash moves the note on show to Trash, and Undo brings it back", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Draft.md", "# Draft\nhalf an idea");
  await app.open("Draft");
  await app.call("idle");
  await page.locator(".tab-editor:not([hidden]) .cm-content").first().focus();
  await app.keys("<Esc>:trash<CR>");
  await page.locator(".notice", { hasText: 'Moved "Draft" to Trash' }).waitFor();
  assert.equal(await exists(page, "Draft.md"), false);
  assert.deepEqual(await page.evaluate(async () => ((await (await fetch("/api/trash")).json()) as Array<{ title: string }>).map((t) => t.title)), ["Draft"]);
  await page.locator(".notice button", { hasText: "Undo" }).click();
  await page.waitForFunction(async () => (await fetch("/api/file?path=Draft.md")).ok);
  assert.deepEqual(await page.evaluate(async () => (await (await fetch("/api/trash")).json()) as unknown[]), []);
});
