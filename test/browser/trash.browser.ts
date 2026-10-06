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

browserTest(h, "a deleted note stays in Trash when a new note takes its path, and restores beside it", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Untitled 1.md", "# Untitled 1\nimportant first draft");
  await deleteNote(app, "Untitled 1.md");
  await app.writeFile("Untitled 1.md", "# Untitled 1\nsomething else");
  await app.command("Open trash");
  await rows(page).first().waitFor();
  await page.locator(".trash-view").focus();
  await page.keyboard.press("r");
  await page.locator(".notice", { hasText: 'Restored "Untitled 1" as Untitled 1 (restored).md: another note has Untitled 1.md now' }).waitFor();
  assert.equal(await app.readFile("Untitled 1 (restored).md"), "# Untitled 1\nimportant first draft");
  assert.equal(await app.readFile("Untitled 1.md"), "# Untitled 1\nsomething else");
});

browserTest(h, "r restores the selected note, even when another delete comes in above it", { scenario: "empty" }, async (app) => {
  const { page } = app;
  for (const n of ["One", "Two", "Three"]) {
    await app.writeFile(`${n}.md`, `# ${n}\n`);
    await deleteNote(app, `${n}.md`);
  }
  await app.writeFile("Agent target.md", "# Agent target\n");
  await app.command("Open trash");
  await rows(page).nth(2).waitFor();
  await page.locator(".trash-view").focus();
  await page.keyboard.press("j");
  const chosen = await page.locator(".trash-row[aria-selected=true]").getAttribute("data-path");
  await deleteNote(app, "Agent target.md");
  await rows(page).nth(3).waitFor();
  assert.equal(await page.locator(".trash-row[aria-selected=true]").getAttribute("data-path"), chosen);
  await page.locator(".trash-view").focus();
  await page.keyboard.press("r");
  await page.waitForFunction((p) => fetch(`/api/file?path=${encodeURIComponent(p)}`).then((r) => r.ok), chosen!);
  assert.equal(await exists(page, "Agent target.md"), false);
});

browserTest(h, "after :trash the note's tab closes and it leaves the notes list", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Draft.md", "# Draft\nhalf an idea");
  await app.writeFile("Other.md", "# Other\n");
  await app.open("Draft");
  await app.call("idle");
  await page.locator(".tab-editor:not([hidden]) .cm-content").first().focus();
  await app.keys("<Esc>:trash<CR>");
  await page.locator(".notice", { hasText: "Moved" }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll("#notes a")].some((a) => a.textContent === "Draft"));
  const tabs = ((await app.call("state")) as { windows: Array<{ tabs: Array<{ label: string }> }> }).windows.flatMap((w) => w.tabs.map((t) => t.label));
  assert.equal(tabs.includes("Draft"), false, JSON.stringify(tabs));
});

browserTest(h, "a link says In Trash by where it points from its note: relative links, and names with spaces", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Plan.md", "# Plan (root)\n");
  await app.writeFile("Projects/Plan.md", "# Plan (projects)\n");
  await app.writeFile("Projects/Gone.md", "# Gone\n");
  await app.writeFile("My Note.md", "# My Note\n");
  await app.writeFile("Projects/Index.md", "# Index\nA [md link](Plan.md)\nB [[Plan]]\nC [md to gone](Gone.md)\nD [spaced](<../My Note.md>)\n");
  for (const p of ["Plan.md", "Projects/Gone.md", "My Note.md"]) await deleteNote(app, p);
  await app.open("Projects/Index.md");
  await page.locator(".tab-editor:not([hidden]) .trash-link").nth(2).waitFor();
  const lines = await page.locator(".tab-editor:not([hidden]) .cm-line").evaluateAll((ls) => ls.filter((l) => l.querySelector(".trash-link")).map((l) => (l.textContent ?? "").slice(0, 1)));
  assert.deepEqual(lines, ["B", "C", "D"]);
});

browserTest(h, "a mouse drag across a row doesn't open it", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Groceries.md", "# Groceries\n");
  await deleteNote(app, "Groceries.md");
  await app.command("Open trash");
  const row = rows(page).first();
  await row.waitFor();
  const b = (await row.boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".trash-peek").count(), 0);
  await row.locator(".trash-look").click();
  await page.locator(".trash-inside button", { hasText: "Restore" }).waitFor();
});

browserTest(h, "a note deleted forever is gone from this browser too: not kept to open offline", { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] }, async (app) => {
  const { page } = app;
  await app.writeFile("Diary.md", "# Diary\nzanzibarmarker");
  await app.open("Diary");
  await app.call("idle");
  await page.waitForFunction(() => new Promise((done) => {
    const open = indexedDB.open("common-ink");
    open.onsuccess = () => {
      const db = open.result;
      const names = [...db.objectStoreNames];
      if (!names.includes("files")) return done(false);
      const get = db.transaction("files").objectStore("files").get("Diary.md");
      get.onsuccess = () => done(!!get.result);
      get.onerror = () => done(false);
    };
    open.onerror = () => done(false);
  }));
  const d = await page.evaluate(async () => {
    const f = await (await fetch("/api/file?path=Diary.md")).json();
    return (await (await fetch("/api/file", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "Diary.md", base: f.revision }) })).json()).file.revision as number;
  });
  assert.equal(await page.evaluate(async (d) => (await fetch("/api/purge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deleted: [d] }) })).status, d), 200);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __commonInk?: unknown }).__commonInk);
  await app.call("idle");
  await page.context().setOffline(true);
  const kept = await page.evaluate(() => new Promise<string>((done) => {
    const open = indexedDB.open("common-ink");
    open.onsuccess = () => {
      const get = open.result.transaction("files").objectStore("files").get("Diary.md");
      get.onsuccess = () => done(JSON.stringify(get.result ?? null));
    };
  }));
  assert.equal(kept.includes("zanzibarmarker"), false, kept);
  await page.context().setOffline(false);
});

const historyOf = (page: Page, path: string) =>
  page.evaluate(async (path) => ((await (await fetch(`/api/history?path=${encodeURIComponent(path)}`)).json()) as Array<{ purged?: true; deleted?: true; author: { kind: string } }>).map((c) => `${c.purged ? "purged" : c.deleted ? "deleted" : "written"} by ${c.author.kind}`), path);

browserTest(h, "D deletes a note forever after asking: its text leaves history, and one line says who did it", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Secret.md", "# Secret\nthe code is 1234");
  await deleteNote(app, "Secret.md");
  await app.command("Open trash");
  await rows(page).first().waitFor();
  await page.locator(".trash-view").focus();
  await page.keyboard.press("Shift+D");
  await page.locator(".dialog-actions button", { hasText: "Cancel" }).click();
  assert.equal(await rows(page).count(), 1, "Cancel keeps it");
  await page.locator(".trash-view").focus();
  await page.keyboard.press("Shift+D");
  await page.locator(".dialog-actions button", { hasText: "Delete forever" }).click();
  await page.locator(".trash-empty").waitFor();
  assert.deepEqual(await historyOf(page, "Secret.md"), ["purged by user"]);
  const old = await page.context().request.get(new URL("/api/version?path=Secret.md&revision=1", page.url()).href);
  assert.equal(old.status(), 404, "its old text can't be read");
});

browserTest(h, "Empty Trash deletes every note in it forever, after asking", { scenario: "empty" }, async (app) => {
  const { page } = app;
  for (const name of ["One", "Two"]) {
    await app.writeFile(`${name}.md`, `# ${name}`);
    await deleteNote(app, `${name}.md`);
  }
  await app.command("Open trash");
  await rows(page).nth(1).waitFor();
  await page.locator(".trash-empty-all").click();
  await page.locator(".dialog-actions button", { hasText: "Empty Trash" }).click();
  await page.locator(".trash-empty").waitFor();
  assert.deepEqual([await historyOf(page, "One.md"), await historyOf(page, "Two.md")], [["purged by user"], ["purged by user"]]);
});

browserTest(h, "on a phone, a swipe left asks, then deletes forever", { scenario: "empty", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await app.writeFile("Groceries.md", "# Groceries\nEggs");
  await deleteNote(app, "Groceries.md");
  await app.command("Open trash");
  const row = rows(page).first();
  await row.waitFor();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number) => [{ x, y: box.y + box.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(330) });
  for (let x = 300; x >= 60; x -= 30) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x) });
  assert.match((await row.getAttribute("data-swipe")) ?? "", /delete armed/, "red, and ready to delete");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // The tap on the dialog's button goes through the same touch input as the swipe, as a finger's would.
  const button = page.locator(".dialog-actions button", { hasText: "Delete forever" });
  await button.waitFor();
  const b = (await button.boundingBox())!;
  const tap = [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tap });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.locator(".trash-empty").waitFor();
  assert.deepEqual(await historyOf(page, "Groceries.md"), ["purged by user"]);
});
