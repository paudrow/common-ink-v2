import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import type { FilePath, FileSummary, WorkspaceFile } from "../worker/src/files.ts";
import { combine, DEFAULT_KEYBINDINGS } from "../worker/src/settings.ts";
import { commandForKey } from "../web/src/commands.ts";
import { editorKeys } from "../web/src/editor.ts";
import { confined, ExtensionHost, ownPrefix, type BuiltIn } from "../web/src/extension-host.ts";

const manifest = (id: string, more: Record<string, unknown> = {}): ExtensionManifest => {
  const m = parseManifest({ name: id, ...more }, id);
  if (typeof m === "string") throw new Error(m);
  return m;
};

const builtIn = (id: string, more: Record<string, unknown> = {}): BuiltIn => ({
  manifest: manifest(id, more),
  load: async () => ({ activate() {} }),
  files: ["index.js"],
  source: async () => "",
  copy: async () => ({}),
  folder: `web/src/extensions/${id}`,
});

/** The app's own commands and views, as the runtime reads them before extensions go in. */
const APP_IDS = ["quickOpen", "commandBar", "note.save", "settings.user", "settings.workspaceJson", "extensions.show", "extensions.openInWindow", "tab.close", "account.signOut", "extensions", "extension-activity", "settings"];

/** Built-ins named as the real ones are: some put their commands under another name than their id. */
const BUILT_INS = [
  builtIn("lists", { contributes: { commands: [{ command: "lists.indent", title: "Indent" }], keybindings: [{ key: "Alt-ArrowRight", command: "lists.indent" }, { vim: ">", command: "lists.indent" }] } }),
  builtIn("data-sources", { contributes: { commands: [{ command: "dataSources.show", title: "Show" }] } }),
  builtIn("calendar", { contributes: { commands: [{ command: "google.connect", title: "Connect" }], search: { types: [{ type: "event", title: "Events" }] } } }),
  builtIn("tasks", { contributes: { commands: [{ command: "tasks.toggle", title: "Toggle" }], search: { types: [{ type: "task", title: "Tasks" }] }, embeds: [{ language: "kanban", title: "Board", description: "" }] } }),
  builtIn("quick-open"),
];

/** Load workspace extensions (sandboxed unless `trusted`) alongside the built-ins, as the app does. */
async function load(extensions: Record<string, Record<string, unknown>>, trusted: string[] = [], keys: (mac: boolean) => readonly string[] = () => []) {
  const files: FileSummary[] = Object.keys(extensions).map((id) => ({ path: `.common-ink/extensions/${id}/extension.json` as FilePath, revision: 1 }) as FileSummary);
  const read = async (path: FilePath) => ({ path, text: JSON.stringify({ name: path.split("/")[2], ...extensions[path.split("/")[2]] }), revision: 1 }) as WorkspaceFile;
  const h = new ExtensionHost({ context: () => ({}) as never, load: async () => ({}), sandbox: async () => {}, changed: () => {}, app: () => ({ ids: [...APP_IDS, "levers", "dev"], keys }) });
  await h.load(BUILT_INS, files, read, [], false, trusted);
  return h;
}

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code: `Key${key.toUpperCase()}`,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

/** The command a press runs, with what the extensions that are on bind, on a Mac or off one. */
const runs = (h: ExtensionHost, e: ReturnType<typeof press>, mac: boolean, user: Array<{ key: string; command: string }> = []) => {
  const fromExtensions = h.on().flatMap((m) => m.contributes.keybindings.flatMap((k) => ("key" in k ? [{ key: k.key, command: k.command }] : [])));
  return commandForKey(e, combine({ keybindings: user }, {}, fromExtensions).keybindings, mac);
};

test("a sandboxed extension can't take the app's save key off a Mac by writing it Mod-Ctrl-s", async () => {
  const h = await load({ taker: { contributes: { commands: [{ command: "taker.go", title: "Go" }], keybindings: [{ key: "Mod-Ctrl-s", command: "taker.go" }] } } });
  assert.equal(DEFAULT_KEYBINDINGS.find((k) => k.key === "Mod-s")?.command, "note.save");
  assert.equal(runs(h, press("s", { ctrl: true }), false), "note.save", "Ctrl+S off a Mac still saves");
});

test("a sandboxed extension's key is the same press as the app's however it's spelled, on a Mac or off one", async () => {
  const keys = ["Mod-Ctrl-s", "Ctrl-Mod-s", "Ctrl-s", "Mod-S", "Shift-Mod-p", "Mod-Shift-P", "Alt-ArrowRight", "Meta-j", "Cmd-j", "j", "Shift-j", "Mod-z", "Mod-v", "Mod-j", "Mod-Alt-j", "Mod-Shift-Alt-j", "Ctrl-Alt-j"];
  const h = await load({ taker: { contributes: { commands: [{ command: "taker.go", title: "Go" }], keybindings: keys.map((key) => ({ key, command: "taker.go" })) } } }, [], editorKeys);
  assert.deepEqual(
    h.records.find((r) => r.id === "taker")!.manifest.contributes.keybindings.map((k) => ("key" in k ? k.key : k.vim)),
    ["Mod-Alt-j", "Mod-Shift-Alt-j", "Ctrl-Alt-j"],
    "only presses with ⌘, Ctrl or Alt that nothing else has, on both platforms",
  );
  for (const mac of [true, false]) {
    assert.equal(runs(h, press("s", mac ? { meta: true } : { ctrl: true }), mac), "note.save");
    assert.equal(runs(h, press("p", { ...(mac ? { meta: true } : { ctrl: true }), shift: true }), mac), "commandBar");
    assert.equal(runs(h, press("z", mac ? { meta: true } : { ctrl: true }), mac), null, "the editor keeps undo");
    assert.equal(runs(h, press("j"), mac), null, "typing j is still typing");
  }
  assert.equal(runs(h, press("j", { meta: true, alt: true }), true), "taker.go", "its own key is its own");
});

test("a key you bind in settings wins over a sandboxed extension's", async () => {
  const h = await load({ taker: { contributes: { commands: [{ command: "taker.go", title: "Go" }], keybindings: [{ key: "Mod-Alt-j", command: "taker.go" }] } } });
  assert.equal(runs(h, press("j", { meta: true, alt: true }), true, [{ key: "Mod-Alt-j", command: "note.save" }]), "note.save");
});

test("a trusted extension's key is taken too, and a sandboxed extension binds no Vim sequence", async () => {
  const h = await load(
    {
      trusty: { contributes: { commands: [{ command: "trusty.go", title: "Go" }], keybindings: [{ key: "Mod-Alt-k", command: "trusty.go" }] } },
      taker: { contributes: { commands: [{ command: "taker.go", title: "Go" }], keybindings: [{ key: "Mod-Alt-k", command: "taker.go" }, { vim: "dd", command: "taker.go" }, { vim: ">>", command: "taker.go" }, { vim: "gz", command: "taker.go" }] } },
    },
    ["trusty"],
  );
  assert.deepEqual(h.records.find((r) => r.id === "taker")!.manifest.contributes.keybindings, []);
  assert.equal(runs(h, press("k", { meta: true, alt: true }), true), "trusty.go");
});

test("a sandboxed extension can't be named for the app's or a built-in's commands and views, in any spelling", async () => {
  const refused = ["settings", "Settings", "SETTINGS", "extensions", "extension-activity", "levers", "dev", "lists.indent", "Lists.Indent", "dataSources", "datasources", "DataSources", "google", "quickOpen", "quickopen", "command-bar", "tab", "account", "note", "note.helper", "task", "event", "kanban"];
  const fine = ["word-count", "settingsy", "my.settings", "listsy", "tabby", "notes-plus"];
  const h = await load(Object.fromEntries([...refused, ...fine].map((id) => [id, {}])));
  const states = Object.fromEntries(h.records.filter((r) => r.workspace).map((r) => [r.id, r.state]));
  assert.deepEqual(states, Object.fromEntries([...refused.map((id) => [id, "failed"]), ...fine.map((id) => [id, "inactive"])]));
  assert.equal(
    h.records.find((r) => r.id === "settings")!.error,
    `"settings" is a name the app or a built-in extension uses for its own commands and views, so an extension in a folder named that can't run sandboxed. Rename its folder.`,
  );
  assert.deepEqual(h.on().map((m) => m.id).filter((id) => !BUILT_INS.some((b) => b.manifest.id === id)), fine, "none of the refused ones is on");
});

test("a customized copy of a built-in runs in its place once you trust it; until then the built-in runs as it shipped", async () => {
  const copy = { name: "Lists, customized", contributes: { commands: [{ command: "lists.indent", title: "Indent" }] } };
  const trusted = (await load({ lists: copy }, ["lists"])).records.find((x) => x.id === "lists")!;
  assert.deepEqual([trusted.tier, trusted.state, trusted.manifest.name, !!trusted.untrustedCopy], ["page", "inactive", "Lists, customized", false]);
  const h = await load({ lists: copy, "data-sources": {}, "quick-open": {} });
  for (const id of ["lists", "data-sources", "quick-open"]) {
    const r = h.records.filter((x) => x.id === id);
    assert.deepEqual(r.map((x) => [x.tier, x.state, x.manifest.name, !!x.workspace, x.untrustedCopy]), [["page", "inactive", id, true, true]], id);
  }
});

test("a sandboxed extension can't bind Vim's Ctrl keys on either platform", async () => {
  const keys = ["Ctrl-r", "Ctrl-w", "Mod-o", "Ctrl-^", "Mod-g", "Mod-Shift-o", "Alt-o"];
  const h = await load({ taker: { contributes: { commands: [{ command: "taker.go", title: "Go" }], keybindings: keys.map((key) => ({ key, command: "taker.go" })) } } });
  assert.deepEqual(h.records.find((r) => r.id === "taker")!.manifest.contributes.keybindings.map((k) => ("key" in k ? k.key : k.vim)), ["Mod-Shift-o", "Alt-o"]);
});

test("a sandboxed extension installed while the app runs is refused a name the app uses, with the reason", async () => {
  const h = await load({});
  const read = async (path: FilePath) => ({ path, text: JSON.stringify({ name: "Account helper" }), revision: 1 }) as WorkspaceFile;
  const r = await h.add({ id: "account", manifestPath: ".common-ink/extensions/account/extension.json" as FilePath, files: [".common-ink/extensions/account/extension.json" as FilePath], version: "1" }, read);
  assert.deepEqual([r?.state, r?.error?.slice(0, 41)], ["failed", `"account" is a name the app or a built-in`]);
  assert.equal(h.on().some((m) => m.id === "account"), false);
});

test("confined drops anything named in a name the app or a built-in uses, even under the extension's own id", () => {
  const m = manifest("settings", {
    contributes: {
      commands: [{ command: "settings.workspaceJson", title: "Workspace settings" }, { command: "settings.helper", title: "Help" }],
      keybindings: [{ key: "Mod-Alt-j", command: "settings.helper" }],
      views: { sidebar: [{ id: "settings", name: "Settings" }] },
      menus: { commandBar: [{ command: "settings.workspaceJson" }] },
      statusBarItems: [{ id: "x", alignment: "left", command: "settings.workspaceJson" }],
      search: { types: [{ type: "task", title: "Tasks" }, { type: "settings-hits", title: "Hits" }] },
      embeds: [{ language: "kanban", title: "Board", description: "" }],
      urlEmbeds: [{ id: "films", title: "Films", pattern: "^https://films\\.example/", frameHosts: ["films.example"] }],
    },
  });
  const c = confined(m, { names: new Set(["settings", "task", "kanban"]), keys: new Set() }).contributes;
  assert.deepEqual(
    [c.commands, c.keybindings, Object.values(c.views).flat(), c.menus.commandBar, c.statusBarItems.map((i) => i.command), c.search.types, c.embeds, c.urlEmbeds],
    [[], [], [], [], [undefined], [{ type: "settings-hits", title: "Hits" }], [], []],
  );
});

test("a sandboxed extension's contributions are kept only by a rule for their kind", () => {
  const m = manifest("word-count", { contributes: { commands: [{ command: "wordCount.go", title: "Go" }] } });
  const withNewKind = { ...m, contributes: { ...m.contributes, widgets: [{ command: "settings.workspaceJson" }], gadgets: [{ command: "account.signOut" }] } };
  const kept = confined(withNewKind as ExtensionManifest, { names: new Set(), keys: new Set() }).contributes as unknown as Record<string, unknown>;
  assert.equal("widgets" in kept || "gadgets" in kept, false, "a kind confined() has no rule for isn't kept");
  assert.deepEqual(kept.commands, [{ command: "wordCount.go", title: "Go" }]);
});

test("a sandboxed extension's places and toolbar buttons keep only its own commands and views", () => {
  const m = manifest("sneaky", {
    contributes: {
      commands: [{ command: "sneaky.hello", title: "Hello" }],
      views: { sidebar: [{ id: "sneaky.list", name: "List" }] },
      places: [
        { id: "own", title: "Own", command: "sneaky.hello" },
        { id: "view", title: "View", view: "sneaky.list" },
        { id: "core", title: "Core", command: "settings.workspaceJson" },
        { id: "other", title: "Other", command: "lists.indent" },
        { id: "theirs", title: "Theirs", view: "settings" },
      ],
      toolbar: [
        { command: "sneaky.hello", title: "Own", label: "O" },
        { command: "lists.indent", title: "Other", label: "L" },
        { command: "note.save", title: "Core", label: "S" },
      ],
    },
  });
  const c = confined(m, { names: new Set(["settings"]), keys: new Set() }).contributes;
  assert.deepEqual(c.places.map((p) => p.id), ["own", "view"]);
  assert.deepEqual(c.toolbar.map((t) => t.command), ["sneaky.hello"]);
});

test("a sandboxed extension's command bar prefix starts with its own name, as a word", () => {
  const cases: Array<[string, string, boolean]> = [
    ["flood", "flood ", true],
    ["flood", "flood", true],
    ["flood", "Flood:", true],
    ["word-count", "wordCount:", true],
    ["word-count", "word-count ", true],
    ["flood", "", false],
    ["flood", ">", false],
    ["flood", "> flood", false],
    ["flood", "floodgate ", false],
    ["e", "event:", false],
    ["word", "word-count ", false],
    ["word", "word.count ", false],
  ];
  assert.deepEqual(cases.map(([id, prefix]) => [id, prefix, ownPrefix(id, prefix)]), cases);
});

test("a command the app registers after a sandboxed extension's, under the same id, is the app's: its keys, menus and status clicks don't reach it", async () => {
  const { Commands } = await import("../web/src/commands.ts");
  const { ExtensionRuntime } = await import("../web/src/extension-runtime.ts");
  const { DEFAULTS } = await import("../worker/src/settings.ts");
  const commands = new Commands();
  const ran: string[] = [];
  const manifest = { name: "Late", contributes: { commands: [{ command: "late.go", title: "Go" }], keybindings: [{ key: "Mod-Alt-j", command: "late.go" }], menus: { commandBar: [{ command: "late.go" }] } } };
  const views = new Map<string, unknown>();
  const runtime = new ExtensionRuntime({
    me: "you@example.com",
    commands,
    bar: { provide() {}, open() {} } as never,
    search: { provide() {}, find: async () => [], extraKeys: () => [] } as never,
    onChange: [],
    panels: { register() {}, toggle() {}, show() {}, shown: () => null, refresh() {} } as never,
    workbench: { registerView: (v: { id: string }) => views.set(v.id, v), view: (id: string) => views.get(id), viewIds: () => [...views.keys()], openView() {}, provideViews() {}, refreshView() {}, extend() {}, notice() {} } as never,
    offline: { read: async (path: string) => ({ path, text: JSON.stringify(manifest), revision: 1 }) } as never,
    settings: () => DEFAULTS,
    files: () => [],
    openFromBar() {},
    lastFile: () => null,
    statusItems: { declare() {}, set() {} } as never,
    onSaved: [],
    onRecords: [],
    onFocus: [],
    saveGrant: async () => {},
    prompt: async () => "deny" as const,
    undeclared() {},
    changed() {},
    device: { facts: { width: "large", px: 1440, pointer: "fine", touch: false, keyboard: true }, override: () => undefined, has: () => true, atLeast: () => true, why: () => "", onChange: () => () => {}, describe: () => ({}) } as never,
    promoted() {},
  });
  await runtime.load([], [{ path: ".common-ink/extensions/late/extension.json" as FilePath, revision: 1 } as FileSummary], [], false, []);
  runtime.declare();
  const theirs = () => [runtime.keybindings().map((k) => k.command), runtime.menu("commandBar").map((i) => i.command)];
  assert.deepEqual(theirs(), [["late.go"], ["late.go"]], "its own, as declared");
  commands.register({ id: "late.go", title: "The app's", run: () => void ran.push("the app's late.go") });
  assert.deepEqual(theirs(), [[], []]);
  runtime.runFor("late", "late.go");
  assert.deepEqual(ran, [], "its status item's click doesn't run the app's command");
});

test("a sandboxed extension's search filter keys are named for it, so ordinary words stay searchable", () => {
  const m = manifest("word-count", { contributes: { search: { types: [{ type: "word-count", title: "Counts" }], filters: ["meeting", "word-count", "word-count-done", "wordcount", "words"].map((filter) => ({ filter, description: "", values: [] })) } } });
  assert.deepEqual(confined(m, { names: new Set(), keys: new Set() }).contributes.search.filters.map((f) => f.filter), ["word-count", "word-count-done", "wordcount"]);
});

test("a sandboxed extension can't declare a built-in's status item, even with that built-in turned off", async () => {
  const vim = builtIn("vim", { contributes: { statusBarItems: [{ id: "vim.mode", alignment: "left" }] } });
  const text = JSON.stringify({ name: "Moder", contributes: { statusBarItems: [{ id: "vim.mode", alignment: "left" }, { id: "moder.mode", alignment: "left" }] } });
  const h = new ExtensionHost({ context: () => ({}) as never, load: async () => ({}), sandbox: async () => {}, changed: () => {} });
  await h.load([vim], [{ path: ".common-ink/extensions/moder/extension.json" as FilePath, revision: 1 } as FileSummary], async (path) => ({ path, text, revision: 1 }) as WorkspaceFile, ["vim"], false, []);
  assert.deepEqual(h.records.find((r) => r.id === "moder")!.manifest.contributes.statusBarItems.map((i) => i.id), ["moder.mode"]);
});
