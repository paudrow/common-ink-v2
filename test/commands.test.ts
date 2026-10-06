import assert from "node:assert/strict";
import { test } from "node:test";
import { providerFor, type Provider } from "../web/src/commandbar.ts";
import { commandForKey, Commands, keyFor } from "../web/src/commands.ts";
import { fuzzyFilter, fuzzyScore } from "../web/src/fuzzy.ts";
import { formatKeys, matchKeys } from "../web/src/keys.ts";

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, code = "") => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

test("shortcuts match the character typed, so they follow the keyboard layout", () => {
  // Dvorak's "p" is on QWERTY's R key: the character decides, not the key's position.
  assert.equal(matchKeys(key("p", { meta: true }, "KeyR"), "Mod-p", true), true);
  assert.equal(matchKeys(key("r", { meta: true }, "KeyP"), "Mod-p", true), false);
});

test("Mod is ⌘ on a Mac and Ctrl elsewhere, and modifiers must match exactly", () => {
  assert.equal(matchKeys(key("p", { meta: true }), "Mod-p", true), true);
  assert.equal(matchKeys(key("p", { ctrl: true }), "Mod-p", true), false);
  assert.equal(matchKeys(key("p", { ctrl: true }), "Mod-p", false), true);
  assert.equal(matchKeys(key("P", { meta: true, shift: true }), "Mod-Shift-p", true), true);
  assert.equal(matchKeys(key("P", { meta: true, shift: true }), "Mod-p", true), false);
  assert.equal(matchKeys(key(">", { ctrl: true, shift: true }), "Ctrl-Shift-.", true), true);
  assert.equal(matchKeys(key("Enter"), "Enter", true), true);
});

test("shortcuts are written the platform's way", () => {
  assert.equal(formatKeys("Mod-Shift-p", true), "⌘⇧P");
  assert.equal(formatKeys("Mod-Shift-p", false), "Ctrl+Shift+P");
});

test("a key press runs the command bound to it, and later bindings win", () => {
  const bindings = [
    { key: "Mod-p", command: "quickOpen" },
    { key: "Mod-s", command: "note.save" },
    { key: "Mod-p", command: "mine" },
  ];
  assert.equal(commandForKey(key("p", { meta: true }), bindings, true), "mine");
  assert.equal(commandForKey(key("s", { meta: true }), bindings, true), "note.save");
  assert.equal(commandForKey(key("x", { meta: true }), bindings, true), null);
  assert.equal(keyFor("note.save", bindings), "Mod-s");
});

test("commands run by id and list by title", () => {
  const ran: string[] = [];
  const commands = new Commands();
  commands.register({ id: "b", title: "Save note", run: () => ran.push("b") }, { id: "a", title: "Open note…", run: () => ran.push("a") });
  assert.equal(commands.run("b"), true);
  assert.equal(commands.run("nope"), false);
  assert.deepEqual(ran, ["b"]);
  assert.deepEqual(
    commands.all().map((c) => c.id),
    ["a", "b"],
  );
});

test("fuzzy matching finds characters in order and prefers word starts and runs", () => {
  assert.equal(fuzzyScore("xyz", "Reading list"), null);
  assert.deepEqual(
    fuzzyFilter("rli", ["Projects/Plan", "Reading list", "World"], (s) => s),
    ["Reading list"],
  );
  assert.equal(fuzzyFilter("rl", ["Projects/Plan", "World", "Reading list"], (s) => s)[0], "Reading list");
  assert.deepEqual(
    fuzzyFilter("plan", ["Explanation", "Projects/Plan"], (s) => s),
    ["Projects/Plan", "Explanation"],
  );
  assert.deepEqual(fuzzyFilter("", ["b", "a"], (s) => s), ["b", "a"]);
});

test("the command bar picks a provider by prefix", () => {
  const notes: Provider = { prefix: "", placeholder: "", items: () => [] };
  const commands: Provider = { prefix: ">", placeholder: "", items: () => [] };
  assert.deepEqual(providerFor("> save", [notes, commands]), { provider: commands, query: "save" });
  assert.deepEqual(providerFor("plan", [notes, commands]), { provider: notes, query: "plan" });
  assert.equal(providerFor("plan", [commands]), null);
});

test("a command run for a key can decline it, and the key does what it would have", async () => {
  const { Commands } = await import("../web/src/commands.ts");
  const commands = new Commands();
  commands.register({ id: "here", title: "Here", run: () => false }, { id: "there", title: "There", run: () => undefined }, { id: "later", title: "Later", run: async () => false });
  assert.equal(commands.runForKey("here"), false, "declined: false, at once");
  assert.equal(commands.runForKey("there"), true);
  assert.equal(commands.runForKey("later"), true, "an answer that comes later is too late to give the key back");
  assert.equal(commands.runForKey("nowhere"), false);
});

test("a binding the typed character matches wins over one matched by where the key sits", async () => {
  const { learnLayout } = await import("../web/src/keys.ts");
  // Dvorak: QWERTY's E key types a dot. A key event that says "E" on that key is still ⌘⇧E.
  await learnLayout({ getLayoutMap: async () => new Map([["KeyE", "."]]) });
  try {
    const bindings = [
      { key: "Mod-Shift-e", command: "archive.toggle" },
      { key: "Mod-Shift-.", command: "tasks.quickAdd" },
    ];
    assert.equal(commandForKey(key("E", { meta: true, shift: true }, "KeyE"), bindings, true), "archive.toggle");
    assert.equal(commandForKey(key("π", { meta: true, shift: true }, "KeyE"), bindings, true), "tasks.quickAdd", "a symbol typed: the key's place decides");
  } finally {
    await learnLayout({ getLayoutMap: async () => new Map() });
  }
});

test("an app-only command runs for the app, and a sandboxed extension's run of it is refused", () => {
  let ran = 0;
  const commands = new Commands();
  commands.register({ id: "device.keyboardYes", title: "Keyboard", appOnly: true, run: () => ran++ }, { id: "note.save", title: "Save", run: () => ran++ });
  assert.equal(commands.run("device.keyboardYes"), true);
  assert.throws(() => commands.run("device.keyboardYes", "sandbox"), /Only the app runs "device.keyboardYes"/);
  assert.equal(ran, 1);
  assert.equal(commands.run("note.save", "sandbox"), true);
  assert.equal(ran, 2);
});
