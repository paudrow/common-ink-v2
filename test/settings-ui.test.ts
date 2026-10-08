import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { FilePath, Revision } from "../worker/src/files.ts";
import { CORE_CATALOG, DEFAULTS } from "../worker/src/settings.ts";

const { window } = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, { document: window.document, CSS: { escape: (s: string) => s.replace(/["\\]/g, "\\$&") } });

const { describeKey, settingsEditor, withSetting } = await import("../web/src/settings-ui.ts");
const { settingsCompletions, settingsProblems } = await import("../web/src/settings-json.ts");

test("setting names read as titles under their section", () => {
  assert.deepEqual(describeKey("editor.fontSize"), { section: "Editor", title: "Font size" });
  assert.deepEqual(describeKey("editor.lineNumbers"), { section: "Editor", title: "Line numbers" });
  assert.deepEqual(describeKey("keybindings"), { section: "Keybindings", title: "Keybindings" });
});

test("a missing settings file starts from the template", () => {
  assert.equal(withSetting("", "editor.livePreview", false), '{\n  "$schema": "/schema/settings.json",\n  "editor.livePreview": false\n}\n');
});

const USER = ".common-ink/users/you@example.com/settings.json" as FilePath;
const WORKSPACE = ".common-ink/settings.json" as FilePath;

/** A settings editor over in-memory user (`text`) and workspace settings files, recording each write. */
function setup(text: string, workspaceText = "") {
  const files = new Map([
    [USER, { text, revision: 1 as Revision }],
    [WORKSPACE, { text: workspaceText, revision: 1 as Revision }],
  ]);
  const file = files.get(USER)!;
  const writes: string[] = [];
  const writtenTo: FilePath[] = [];
  const ui = settingsEditor({
    pathFor: (level) => (level === "user" ? USER : WORKSPACE),
    read: async (path) => ({ ...files.get(path)! }),
    write: async (path, next, base) => {
      const f = files.get(path)!;
      assert.equal(base, f.revision);
      writes.push(next);
      writtenTo.push(path);
      f.text = next;
      f.revision++;
      return { status: "saved", revision: f.revision } as never;
    },
    catalog: () => CORE_CATALOG,
    openJson: () => writes.push("open json"),
    changed: () => {},
  });
  const root = window.document.createElement("div");
  window.document.body.replaceChildren(root);
  return { ui, root, writes, file, files, writtenTo };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("every setting shows, with its control, description and default; set ones are marked", async () => {
  const { ui, root } = setup('{\n  "editor.fontSize": 18\n}\n');
  await ui.render(root);
  const rows = [...root.querySelectorAll(".setting")];
  assert.equal(rows.length, Object.keys(DEFAULTS).length);
  const font = rows.find((r) => r.querySelector(".setting-key")!.textContent === "editor.fontSize")!;
  assert.ok(font.classList.contains("modified"));
  assert.equal(font.querySelector("input")!.value, "18");
  assert.equal(font.querySelector(".setting-default")!.textContent, "Default: 16");
  const preview = rows.find((r) => r.querySelector(".setting-key")!.textContent === "editor.livePreview")!;
  assert.ok(!preview.classList.contains("modified"));
  assert.equal(preview.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked, true);
  const keys = rows.find((r) => r.querySelector(".setting-key")!.textContent === "keybindings")!;
  assert.equal(keys.querySelector("button.to-json")!.textContent, "Edit in settings.json");
});

test("a control writes just its key, and Reset removes it, leaving the rest of the file alone", async () => {
  const text = '{\n    "$schema": "/schema/settings.json",\n    "editor.fontSize":   18 ,\n    "keybindings": [ {"key": "Mod-k", "command": "quickOpen"} ]\n}\n';
  const { ui, root, writes } = setup(text);
  await ui.render(root);
  const box = root.querySelector<HTMLInputElement>('input[aria-label="editor.livePreview"]')!;
  box.checked = false;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(writes.at(-1), '{\n    "$schema": "/schema/settings.json",\n    "editor.fontSize":   18 ,\n    "keybindings": [ {"key": "Mod-k", "command": "quickOpen"} ],\n    "editor.livePreview": false\n}\n');
  await ui.render(root);
  root.querySelector<HTMLButtonElement>('[data-focus="reset:editor.fontSize"]')!.click();
  await settle();
  assert.equal(writes.at(-1), '{\n    "$schema": "/schema/settings.json",\n    "keybindings": [ {"key": "Mod-k", "command": "quickOpen"} ],\n    "editor.livePreview": false\n}\n');
});

test("a number out of range isn't written", async () => {
  const { ui, root, writes } = setup("");
  await ui.render(root);
  const input = root.querySelector<HTMLInputElement>('input[aria-label="editor.fontSize"]')!;
  input.value = "99";
  input.dispatchEvent(new window.Event("change"));
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(input.getAttribute("aria-invalid"), "true");
});

test("a change that can't reach the server says so", async () => {
  const root = window.document.createElement("div");
  window.document.body.replaceChildren(root);
  const ui = settingsEditor({
    pathFor: () => ".common-ink/settings.json" as FilePath,
    read: async () => ({ text: "", revision: 0 as Revision }),
    write: async () => {
      throw new TypeError("Failed to fetch");
    },
    catalog: () => CORE_CATALOG,
    openJson: () => {},
    changed: () => void ui.render(root),
  });
  await ui.render(root);
  const box = root.querySelector<HTMLInputElement>('input[aria-label="editor.livePreview"]')!;
  box.checked = false;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  await settle();
  assert.match(root.querySelector('[role="alert"]')!.textContent!, /^Not saved: Failed to fetch/);
});

test("User and Workspace each show their own values, say what the other does, and write to their own file", async () => {
  const { ui, root, files, writtenTo } = setup('{"editor.fontSize": 18, "editor.lineNumbers": true}', '{"editor.lineNumbers": false}');
  const value = (key: string) => root.querySelector<HTMLInputElement>(`input[aria-label="${key}"]`)!;
  const note = (key: string) => [...root.querySelectorAll(".setting")].find((r) => r.querySelector(".setting-key")!.textContent === key)!.querySelector(".setting-note")?.textContent;
  const switchTo = async (level: string) => {
    root.querySelector<HTMLButtonElement>(`[data-focus="level:${level}"]`)!.click();
    await settle();
    await settle();
  };
  await ui.render(root);
  assert.equal(value("editor.fontSize").value, "18");
  assert.equal(value("editor.lineNumbers").checked, true, "yours, though the workspace's wins");
  assert.equal(note("editor.lineNumbers"), "This workspace sets it to false, which wins here.");
  assert.match(root.querySelector(".settings-level")!.textContent!, /^Your settings/);

  await switchTo("workspace");
  assert.equal(root.querySelector('[aria-selected="true"]')!.textContent, "Workspace");
  assert.match(root.querySelector(".settings-level")!.textContent!, /^This workspace's settings/);
  assert.equal(value("editor.lineNumbers").checked, false, "the workspace's own");
  assert.equal(value("editor.fontSize").value, "18", "not set here: yours applies");
  assert.equal(note("editor.fontSize"), "Not set here: your user setting, 18, applies.");
  assert.equal(value("editor.lineWrapping").checked, true, "set nowhere: the default");

  value("editor.lineWrapping").checked = false;
  value("editor.lineWrapping").dispatchEvent(new window.Event("change"));
  await settle();
  assert.deepEqual(writtenTo, [WORKSPACE], "a control writes to the level on show");
  assert.match(files.get(WORKSPACE)!.text, /"editor.lineWrapping": false/);
  assert.doesNotMatch(files.get(USER)!.text, /lineWrapping/);
});

test("search narrows the settings, and the switch shows the other level", async () => {
  const { ui, root } = setup("");
  await ui.render(root);
  const search = root.querySelector<HTMLInputElement>("input.search")!;
  search.value = "wrap";
  search.dispatchEvent(new window.Event("input"));
  const shown = [...root.querySelectorAll<HTMLElement>(".setting")].filter((r) => !r.hidden);
  assert.deepEqual(
    shown.map((r) => r.querySelector(".setting-key")!.textContent),
    ["editor.lineWrapping"],
  );
  root.querySelector<HTMLButtonElement>('[data-focus="level:workspace"]')!.click();
  await settle();
  assert.equal(ui.level, "workspace");
  assert.equal(root.querySelector('[aria-selected="true"]')!.textContent, "Workspace");
});

test("completion offers the settings not yet in the file where a key goes, and values where a value goes", () => {
  const text = '{\n  "editor.livePreview": true,\n  "edi\n}';
  const at = text.indexOf("edi\n") + 3;
  const keys = settingsCompletions(text, at)!;
  assert.equal(keys.from, at - 3, "matched against what's typed after the quote");
  const labels = keys.options.map((o) => o.label);
  assert.ok(labels.includes("editor.fontSize") && !labels.includes("editor.livePreview"));
  assert.equal(keys.options.find((o) => o.label === "editor.fontSize")!.apply, 'editor.fontSize": 16');
  assert.equal(keys.options.find((o) => o.label === "keybindings")!.apply, 'keybindings": []');
  const bare = '{\n  font';
  assert.equal(settingsCompletions(bare, bare.length)!.options.find((o) => o.label === "editor.fontSize")!.apply, '"editor.fontSize": 16', "typed without a quote, the pick brings both");

  const value = '{\n  "editor.lineNumbers": t';
  const values = settingsCompletions(value, value.length)!;
  assert.deepEqual(values.options.map((o) => o.label), ["true", "false"]);
  assert.equal(values.from, value.length - 1);
  assert.equal(settingsCompletions('{\n  "editor.fontSize": 1', 23), null, "numbers have nothing to pick from");
  assert.equal(settingsCompletions('{\n  "keybindings": [{"k', 23), null, "only top-level keys");
});

test("problems point at an unknown key, a wrong value, or where the JSON breaks", () => {
  const text = '{\n  "colour": 1,\n  "editor.livePreview": "yes"\n}';
  const problems = settingsProblems(text);
  assert.deepEqual(
    problems.map((p) => [text.slice(p.from, p.to), p.message]),
    [
      ['"colour": ', 'Unknown setting "colour". It\'s ignored.'],
      ['"yes"', '"editor.livePreview" must be true or false. It\'s ignored.'],
    ],
  );
  assert.match(settingsProblems("{oops", [1])[0].message, /^Not valid JSON/);
  assert.deepEqual(settingsProblems('{"editor.fontSize": 12}'), []);
});

test("a drawing still reading its files gives way to a newer one, instead of drawing over it", async () => {
  const { root, files } = setup('{\n  "editor.fontSize": 18\n}\n');
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  // The first drawing's read of the user settings is slow; the second's isn't.
  let userReads = 0;
  const ui = settingsEditor({
    pathFor: (level) => (level === "user" ? USER : WORKSPACE),
    read: async (path) => {
      if (path === USER && userReads++ === 0) await held;
      return { ...files.get(path)! };
    },
    write: async () => ({ status: "saved", revision: 2 }) as never,
    catalog: () => CORE_CATALOG,
    openJson: () => {},
    changed: () => {},
  });
  const first = ui.render(root);
  ui.level = "workspace";
  await ui.render(root);
  assert.equal(root.querySelector('[role=tab][aria-selected="true"]')?.textContent, "Workspace");
  release();
  await first;
  await settle();
  assert.equal(root.querySelector('[role=tab][aria-selected="true"]')?.textContent, "Workspace", "the older drawing drew nothing");
});
