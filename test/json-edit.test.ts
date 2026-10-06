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
  "editor.livePreview": true
}
`.replace("  // not JSON, so not here\n", "");

test("changing a key's value leaves everything else exactly as it was", () => {
  assert.equal(setTopLevelKey(file, "editor.fontSize", 20), file.replace('"editor.fontSize": 18', '"editor.fontSize": 20'));
  assert.equal(setTopLevelKey(file, "editor.livePreview", false), file.replace('"editor.livePreview": true', '"editor.livePreview": false'));
});

test("a new key goes at the end, indented like the others", () => {
  assert.equal(setTopLevelKey(file, "editor.lineNumbers", true), file.replace('"editor.livePreview": true', '"editor.livePreview": true,\n  "editor.lineNumbers": true'));
  assert.equal(setTopLevelKey("{}\n", "editor.livePreview", false), '{\n  "editor.livePreview": false\n}\n');
  assert.equal(setTopLevelKey("", "editor.livePreview", false), '{\n  "editor.livePreview": false\n}\n');
});

test("removing a key takes its comma with it, wherever it is", () => {
  for (const key of ["$schema", "editor.fontSize", "keybindings", "editor.livePreview"]) {
    const out = setTopLevelKey(file, key, undefined)!;
    const parsed = JSON.parse(out);
    assert.equal(key in parsed, false, key);
    assert.equal(Object.keys(parsed).length, 3, key);
  }
  assert.equal(setTopLevelKey(file, "editor.livePreview", undefined), file.replace(',\n  "editor.livePreview": true', ""));
  assert.equal(setTopLevelKey(file, "missing", undefined), file);
});

test("a file that isn't a JSON object is left alone", () => {
  assert.equal(setTopLevelKey("[1, 2]", "a", 1), null);
  assert.equal(setTopLevelKey('{"a": }', "a", 1), null);
  assert.deepEqual(topLevelKeys('{"a": {"b": "}"}, "c": [1, "]"]}')?.keys.map((k) => k.key), ["a", "c"]);
});

test("a key written twice is set once: the later copies, which JSON.parse would read, go", () => {
  const file = '{\n  "extensions.trusted": ["a"],\n  "editor.fontSize": 15,\n  "extensions.trusted": ["a", "b"]\n}\n';
  const out = setTopLevelKey(file, "extensions.trusted", ["c"])!;
  assert.deepEqual(JSON.parse(out), { "extensions.trusted": ["c"], "editor.fontSize": 15 });
  assert.equal(out.match(/extensions\.trusted/g)?.length, 1);
});
