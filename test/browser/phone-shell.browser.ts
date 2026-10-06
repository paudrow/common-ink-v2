// The phone shell (web/src/shell.ts), by touch at 375 × 812: the bottom bar, the Places sheet, a note
// over its place with back, the sheets for views about the note and its menu, and the keyboard toolbar.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const bar = (app: App) => app.page.evaluate(() => [...document.querySelectorAll("#shell-bar button")].map((b) => b.getAttribute("aria-label")));
const title = (app: App) => app.page.locator("#shell-top h1").innerText();
const tap = (app: App, selector: string) => app.page.locator(selector).first().tap();
const closeSheet = (app: App) => app.page.evaluate(() => document.querySelector(".modal-scrim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

browserTest(h, "on a phone, the bottom bar goes to places, a note opens over the Feed, and back comes up to it", { scenario: "lists", device: "phone" }, async (app) => {
  assert.deepEqual(await bar(app), ["Feed", "Today", "Calendar", "Search", "Places"]);
  await tap(app, '#shell-bar [aria-label="Feed"]');
  assert.equal(await title(app), "Feed");
  assert.equal(await app.page.locator("#workbench").isVisible(), false, "one screen at a time");
  await tap(app, '#notes a:text("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  assert.equal(await app.page.locator("#notes").isVisible(), false);
  assert.equal(await app.page.evaluate(() => document.activeElement?.closest(".cm-editor") ?? null), null, "opened to read: no on-screen keyboard");

  // The system's back gesture goes back to the list.
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  await tap(app, '#notes a:text("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  // And so does the top bar's back.
  await tap(app, '#shell-top [aria-label="Back to Feed"]');
  assert.equal(await title(app), "Feed");

  await tap(app, '#shell-bar [aria-label="Calendar"]');
  await app.page.locator("#workbench .cal-page").first().waitFor();
  assert.equal(await title(app), "Calendar");
  assert.equal(await app.page.locator('#shell-top [aria-label^="Back"]').count(), 0, "a place has nowhere to go back up to");
  assert.equal(await app.page.locator('#shell-bar [aria-current="page"]').getAttribute("aria-label"), "Calendar");
});

browserTest(h, "the Places sheet lists what there is, and the bottom bar's places can be changed", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Places"]');
  const places = await app.page.locator(".shell-sheet .shell-place").allInnerTexts();
  assert.deepEqual(places, ["Feed", "Today", "Tasks", "Calendar", "Contacts", "Sources", "Uploads", "Extensions", "Settings", "Customize the bottom bar…"]);
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
  await app.page.locator(".shell-sheet label", { hasText: "Calendar" }).locator("input").uncheck();
  await app.page.locator(".shell-sheet label", { hasText: "Tasks" }).locator("input").check();
  await app.page.locator(".shell-sheet .shell-primary").tap();
  await app.page.waitForFunction(() => !document.querySelector(".shell-sheet"));
  assert.deepEqual(await bar(app), ["Feed", "Today", "Tasks", "Search", "Places"]);
  await app.idle();
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/places.json")), { bar: ["feed", "today", "tasks"] });

  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Settings" }).tap();
  await app.page.locator(".settings-editor").waitFor();
  assert.equal(await title(app), "Settings");
});

browserTest(h, "a note's ◷ sheet shows its history, and ⋯ greys what needs a wider screen, with why", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-top [aria-label="History and views about this note"]');
  await app.page.locator(".shell-sheet .shell-switcher", { hasText: "History" }).waitFor();
  await app.page.locator(".shell-sheet .shell-context .change").first().waitFor();
  await closeSheet(app);
  await tap(app, '#shell-top [aria-label="More"]');
  const split = app.page.locator(".shell-sheet .shell-action", { hasText: "split to the right" });
  assert.equal(await split.getAttribute("aria-disabled"), "true");
  assert.match(await split.innerText(), /needs a screen 840px wide/);
});

browserTest(h, "tapping a note edits it, the keyboard toolbar takes the bottom bar's place, and its buttons edit the line", { scenario: "lists", device: "phone" }, async (app) => {
  await app.page.locator(".cm-line", { hasText: "Basil" }).tap();
  await app.page.locator("#shell-toolbar").waitFor();
  assert.equal(await app.page.locator("#shell-bar").isVisible(), false);
  await app.page.locator('#shell-toolbar [aria-label="Make this line a task"]').tap();
  await app.page.locator('#shell-toolbar [aria-label="Add a due date"]').tap();
  assert.equal((await app.editor.cursor())?.text, "    - [ ] Basil due:");
  await app.page.locator('#shell-toolbar [aria-label="Indent"]').tap();
  assert.equal((await app.editor.cursor())?.text, "      - [ ] Basil due:", "Lists' indent, as a button");
  await app.page.locator('#shell-toolbar [aria-label="Hide the keyboard"]').tap();
  await app.page.locator("#shell-bar").waitFor();
  assert.equal(await app.page.locator("#shell-toolbar").isVisible(), false);
});

browserTest(h, "on a laptop there's no shell: the notes list, tabs and status bar as before", { scenario: "lists" }, async (app) => {
  assert.equal(await app.page.locator("#shell-bar").isVisible(), false);
  assert.equal(await app.page.locator("#shell-top").isVisible(), false);
  assert.equal(await app.page.locator("#notes").isVisible(), true);
});
