// Shortcuts match the character a key types, whichever key types it: ⌘⇧. (Ctrl+Shift+. off a Mac)
// is quick-add's on Dvorak as on QWERTY, whether the browser says "." or ">" with Shift held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchKeys, type KeyLike } from "../web/src/keys.ts";

const press = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("⌘⇧. matches by the character typed: QWERTY's Period key, Dvorak's E key, with '.' or '>'", () => {
  const mac = { metaKey: true, shiftKey: true };
  assert.equal(matchKeys(press(">", "Period", mac), "Mod-Shift-.", true), true, "QWERTY, the shifted character");
  assert.equal(matchKeys(press(".", "Period", mac), "Mod-Shift-.", true), true, "QWERTY, the unshifted one");
  assert.equal(matchKeys(press(">", "KeyE", mac), "Mod-Shift-.", true), true, "Dvorak types '.' on the physical E key");
  assert.equal(matchKeys(press(".", "KeyE", mac), "Mod-Shift-.", true), true);
  // Off a Mac, Ctrl stands in for ⌘.
  assert.equal(matchKeys(press(">", "KeyE", { ctrlKey: true, shiftKey: true }), "Mod-Shift-.", false), true);
  // What QWERTY's Period key types on Dvorak ("v") isn't ".".
  assert.equal(matchKeys(press("V", "Period", mac), "Mod-Shift-.", true), false);
  // Modifiers still have to match: ⌘. is the task menu, not quick-add.
  assert.equal(matchKeys(press(".", "KeyE", { metaKey: true }), "Mod-Shift-.", true), false);
  assert.equal(matchKeys(press(".", "KeyE", { metaKey: true }), "Mod-.", true), true);
});

test("a shortcut written with the shifted character (Mod->) is the same one as Mod-Shift-.", () => {
  const mac = { metaKey: true, shiftKey: true };
  assert.equal(matchKeys(press(">", "Period", mac), "Mod->", true), true);
  assert.equal(matchKeys(press(">", "KeyE", mac), "Mod->", true), true, "on Dvorak too");
  assert.equal(matchKeys(press(".", "KeyE", mac), "Mod->", true), true, "with the browser saying '.'");
  assert.equal(matchKeys(press(".", "KeyE", { metaKey: true }), "Mod->", true), false, "without Shift it's ⌘.");
});

test("a shifted character typed without Shift still matches its shortcut, on layouts where it's a key of its own", () => {
  assert.equal(matchKeys(press("+", "BracketRight", { ctrlKey: true }), "Mod-+", false), true, "German: + is unshifted");
  assert.equal(matchKeys(press("+", "Equal", { ctrlKey: true, shiftKey: true }), "Mod-+", false), true, "US: Shift and =");
});
