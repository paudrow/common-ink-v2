// Tab in a note, as standard Vim has it: in insert mode it indents (a list item with its children, by
// Lists); in normal mode it's Ctrl-I, jump forward, and never takes the keyboard out of the note.
// Shift-Tab outside insert mode is the way out, to what's before the note; with Vim off, CodeMirror's
// Escape-then-Tab is.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const inNote = (app: App) => app.page.evaluate(() => !!document.activeElement?.closest(".cm-content"));
const line = async (app: App) => (await app.call<{ line: number; text: string } | null>("where"))!.line;

browserTest(h, "insert mode: Tab indents a line that isn't a list item, Shift-Tab dedents it, and the keyboard stays in the note", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.call("cursor", 1, 1);
  await app.keys("<Esc>jjj");
  // A real keyboard: o opens a blank line above the list, and Tab is pressed there.
  await app.page.keyboard.press("o");
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.type("plain");
  assert.equal(await inNote(app), true, "focus stays in the note");
  await app.page.keyboard.press("Escape");
  await app.idle();
  assert.match((await app.readFile("Lists tour.md")).split("\n")[4], /^\s+plain$/);
  await app.page.keyboard.press("A");
  await app.page.keyboard.press("Shift+Tab");
  await app.page.keyboard.press("Escape");
  await app.idle();
  assert.equal((await app.readFile("Lists tour.md")).split("\n")[4], "plain");
  assert.equal(await inNote(app), true);
});

browserTest(h, "normal mode: Tab is Ctrl-I, jump forward, after Escape too; it never leaves the note", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.call("cursor", 3, 1);
  await app.keys("G<C-o>");
  assert.equal(await line(app), 3);
  const before = await app.readFile("Lists tour.md");
  await app.page.keyboard.press("Tab");
  assert.notEqual(await line(app), 3, "forward to where G went");
  const last = await line(app);
  await app.keys("<C-o>");
  // Escape in normal mode would arm CodeMirror's escape hatch, making the next Tab leave: not with Vim.
  await app.page.keyboard.press("Escape");
  await app.page.keyboard.press("Tab");
  assert.equal(await line(app), last);
  assert.equal(await inNote(app), true, "the keyboard stays in the note");
  await app.idle();
  assert.equal(await app.readFile("Lists tour.md"), before, "nothing was indented");
});

browserTest(h, "normal mode: Shift-Tab is the way out of the note, to what's before it, even on an item it could dedent", { scenario: "lists", open: "Lists tour" }, async (app) => {
  // An indented list item: in insert mode, Shift-Tab would dedent it.
  await app.keys("<Esc>/Order seeds<CR>");
  const before = await app.readFile("Lists tour.md");
  await app.page.keyboard.press("Shift+Tab");
  assert.equal(await inNote(app), false, "focus left the note");
  await app.idle();
  assert.equal(await app.readFile("Lists tour.md"), before, "nothing was dedented");
});

browserTest(h, "with Vim off, Tab indents, and Escape then Tab leaves the note", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "extensions.disabled": ["vim"] }));
  await app.reload();
  await app.open("Lists tour");
  await app.call("cursor", 3, 1);
  await app.page.keyboard.press("Tab");
  assert.equal(await inNote(app), true);
  await app.idle();
  assert.match((await app.readFile("Lists tour.md")).split("\n")[2], /^\s+Lists edit/);
  await app.page.keyboard.press("Escape");
  await app.page.keyboard.press("Tab");
  assert.equal(await inNote(app), false, "CodeMirror's escape hatch, for keyboard users");
});
