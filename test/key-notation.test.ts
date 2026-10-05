// Keys in Vim's notation, as test levers press them (docs/TESTING.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKeys, playwrightKey } from "../web/src/dev/key-notation.ts";

const plain = (key: string, shift = false) => ({ key, ctrl: false, alt: false, meta: false, shift });

test("characters are pressed as they are, and a capital holds Shift", () => {
  assert.deepEqual(parseKeys("jJ>", false), [plain("j"), plain("J", true), plain(">")]);
});

test("named keys and held keys go in angle brackets; <Mod-…> is ⌘ on a Mac and Ctrl elsewhere", () => {
  assert.deepEqual(parseKeys(":w<CR><Esc>", false).map((k) => k.key), [":", "w", "Enter", "Escape"]);
  assert.deepEqual(parseKeys("<C-w>", false), [{ key: "w", ctrl: true, alt: false, meta: false, shift: false }]);
  assert.deepEqual(parseKeys("<Mod-S-p>", true), [{ key: "P", ctrl: false, alt: false, meta: true, shift: true }]);
  assert.deepEqual(parseKeys("<Mod-S-p>", false), [{ key: "P", ctrl: true, alt: false, meta: false, shift: true }]);
  assert.deepEqual(parseKeys("<S-Tab><M-Up>", false).map(playwrightKey), ["Shift+Tab", "Alt+ArrowUp"]);
});

test("a < that doesn't start a name is a <, so Vim's << and <x> work, and <lt> is one too", () => {
  assert.deepEqual(parseKeys("<<", false).map((k) => k.key), ["<", "<"]);
  assert.deepEqual(parseKeys("<b>", false).map((k) => k.key), ["<", "b", ">"]);
  assert.deepEqual(parseKeys("<lt><Space>", false).map((k) => k.key), ["<", " "]);
});

test("a name it doesn't know is an error, not its letters typed", () => {
  assert.throws(() => parseKeys("<Escc>", false), /No key called <Escc>/);
});

test("presses read as Playwright's key names", () => {
  assert.deepEqual(parseKeys("<C-w>l <Mod-S-p>A", false).map(playwrightKey), ["Control+w", "l", "Space", "Control+Shift+P", "Shift+A"]);
});
