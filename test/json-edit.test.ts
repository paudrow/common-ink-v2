import assert from "node:assert/strict";
import { test } from "node:test";
import { setTopLevelKey, topLevelKeys } from "../web/src/json-edit.ts";

const file = `{
  "$schema": "/schema/settings.json",
  // not JSON, so not here
  "editor.fontSize": 18,
  "keybindings": [
    { "key": "Mod-k", "command": "quickOpen" }
  ],
  "editor.vim": true
}
`.replace("  // not JSON, so not here\n", "");

test("changing a key's value leaves everything else exactly as it was", () => {
  assert.equal(setTopLevelKey(file, "editor.fontSize", 20), file.replace('"editor.fontSize": 18', '"editor.fontSize": 20'));
  assert.equal(setTopLevelKey(file, "editor.vim", false), file.replace('"editor.vim": true', '"editor.vim": false'));
});

test("a new key goes at the end, indented like the others", () => {
  assert.equal(setTopLevelKey(file, "editor.lineNumbers", true), file.replace('"editor.vim": true', '"editor.vim": true,\n  "editor.lineNumbers": true'));
  assert.equal(setTopLevelKey("{}\n", "editor.vim", false), '{\n  "editor.vim": false\n}\n');
  assert.equal(setTopLevelKey("", "editor.vim", false), '{\n  "editor.vim": false\n}\n');
});

test("removing a key takes its comma with it, wherever it is", () => {
  for (const key of ["$schema", "editor.fontSize", "keybindings", "editor.vim"]) {
    const out = setTopLevelKey(file, key, undefined)!;
    const parsed = JSON.parse(out);
    assert.equal(key in parsed, false, key);
    assert.equal(Object.keys(parsed).length, 3, key);
  }
  assert.equal(setTopLevelKey(file, "editor.vim", undefined), file.replace(',\n  "editor.vim": true', ""));
  assert.equal(setTopLevelKey(file, "missing", undefined), file);
});

test("a file that isn't a JSON object is left alone", () => {
  assert.equal(setTopLevelKey("[1, 2]", "a", 1), null);
  assert.equal(setTopLevelKey('{"a": }', "a", 1), null);
  assert.deepEqual(topLevelKeys('{"a": {"b": "}"}, "c": [1, "]"]}')?.keys.map((k) => k.key), ["a", "c"]);
});
