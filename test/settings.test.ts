import assert from "node:assert/strict";
import { test } from "node:test";
import { Docs, type Author } from "../worker/src/docs.ts";
import { runOperation } from "../worker/src/operations.ts";
import { combine, DEFAULT_SETTINGS, DEFAULTS, defaultsText, parseSettings, schema, SETTINGS } from "../worker/src/settings.ts";
import { commandForKey, keyFor } from "../web/src/commands.ts";
import { memoryDb } from "./sqlite.ts";

const you: Author = { kind: "user", email: "you@example.com" };

test("a settings file's good settings are used and the rest are reported", () => {
  assert.deepEqual(parseSettings('{"$schema": "/schema/settings.json", "editor.fontSize": 18, "editor.vim": "yes", "colour": 1}'), {
    settings: { "editor.fontSize": 18 },
    problems: ['"editor.vim" must be {"type":"boolean"}', 'Unknown setting "colour"'],
  });
  assert.deepEqual(parseSettings(""), { settings: {}, problems: [] });
  assert.match(parseSettings("{oops").problems[0], /^Not valid JSON/);
  assert.deepEqual(parseSettings("[]").problems, ["Settings must be a JSON object"]);
  assert.deepEqual(parseSettings('{"editor.fontSize": 99}').problems, ['"editor.fontSize" must be {"type":"integer","minimum":10,"maximum":32}']);
});

test("workspace settings override user settings, which override the defaults; keybindings add up", () => {
  const settings = combine(
    { "editor.fontSize": 18, "editor.lineNumbers": true, keybindings: [{ key: "Mod-k", command: "quickOpen" }] },
    { "editor.fontSize": 14, keybindings: [{ key: "Mod-s", command: null }] },
  );
  assert.equal(settings["editor.fontSize"], 14);
  assert.equal(settings["editor.lineNumbers"], true);
  assert.equal(settings["editor.vim"], true);
  const key = (k: string) => ({ key: k, code: "", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
  assert.equal(commandForKey(key("k"), settings.keybindings, true), "quickOpen");
  assert.equal(commandForKey(key("s"), settings.keybindings, true), null, "a null command unbinds the key");
  assert.equal(keyFor("note.save", settings.keybindings), undefined);
  assert.equal(keyFor("quickOpen", settings.keybindings), "Mod-p");
});

test("the schema and the defaults view list every setting", () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", ...Object.keys(SETTINGS)].sort());
  assert.deepEqual(JSON.parse(defaultsText()), { $schema: "/schema/settings.json", ...DEFAULTS });
});

test("the defaults read like a doc but can't be written", async () => {
  const docs = new Docs(memoryDb());
  const read = await runOperation("read_doc", { path: DEFAULT_SETTINGS }, docs, you);
  assert.ok(read.ok && (read.value as { text: string }).text === defaultsText());
  const write = await runOperation("write_doc", { path: DEFAULT_SETTINGS, text: "{}", base: 0 }, docs, you);
  assert.equal(write.ok, false);
});
