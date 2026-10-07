// Tab in a note, as standard Vim has it: in insert mode it types an indent at the cursor (on a list item,
// Lists nests the item), and Ctrl-T and Ctrl-D indent the whole line; in normal mode it's Ctrl-I, jump
// forward, and never takes the keyboard out of the note. Shift-Tab outside insert mode is the way out, to
// the note's tab; with Vim off, Tab indents the line and CodeMirror's Escape-then-Tab is the way out.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const inNote = (app: App) => app.page.evaluate(() => !!document.activeElement?.closest(".cm-content"));
const line = async (app: App) => (await app.call<{ line: number; text: string } | null>("where"))!.line;

const insertTab = async (app: App, line: number, column: number) => {
  await app.call("cursor", line, column);
  await app.keys("<Esc>");
  await app.call("cursor", line, column);
  await app.page.keyboard.press("i");
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.press("Escape");
};

browserTest(h, "insert mode: Tab types an indent at the cursor, mid-line, in a table and in a code block", { scenario: "empty" }, async (app) => {
  await app.writeFile("T.md", "hello world\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nlet x\n```\n");
  await app.open("T");
  await app.idle();
  await insertTab(app, 1, 6);
  await insertTab(app, 5, 4);
  await insertTab(app, 8, 4);
  assert.equal(await inNote(app), true, "focus stays in the note");
  await app.idle();
  const lines = (await app.readFile("T.md")).split("\n");
  assert.equal(lines[0], "hello  world", "to the next indent stop, at the cursor");
  assert.equal(lines[4], "| 1  | 2 |");
  assert.equal(lines[7], "let  x", "from column 3, one space to the stop");
});

browserTest(h, "insert mode: Tab on a blank line indents it, Shift-Tab dedents, and Ctrl-T and Ctrl-D indent the whole line", { scenario: "lists", open: "Lists tour" }, async (app) => {
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
  // Vim's own: Ctrl-T and Ctrl-D in insert mode, wherever the cursor is.
  await app.page.keyboard.press("I");
  await app.page.keyboard.press("Control+t");
  await app.page.keyboard.press("Escape");
  await app.idle();
  assert.match((await app.readFile("Lists tour.md")).split("\n")[4], /^\s+plain$/);
  await app.page.keyboard.press("A");
  await app.page.keyboard.press("Control+d");
  await app.page.keyboard.press("Escape");
  await app.idle();
  assert.equal((await app.readFile("Lists tour.md")).split("\n")[4], "plain");
  assert.equal(await inNote(app), true);
});

browserTest(h, "insert mode: Tab on a list item nests it, as Lists has it", { scenario: "empty" }, async (app) => {
  await app.writeFile("L.md", "- one\n- two\n");
  await app.open("L");
  await app.idle();
  await insertTab(app, 2, 6);
  await app.idle();
  assert.match((await app.readFile("L.md")).split("\n")[1], /^\s+- two$/);
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
  // To the note's tab, not its close button, where Enter would close it.
  assert.deepEqual(
    await app.page.evaluate(() => {
      const a = document.activeElement;
      return [a?.className, a?.closest(".tab")?.getAttribute("aria-selected"), a?.textContent];
    }),
    ["name", "true", "Lists tour"],
  );
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
