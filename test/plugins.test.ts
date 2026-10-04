import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { FilePath, FileSummary, WorkspaceFile } from "../worker/src/files.ts";
import { changedPlugins, dryRun, isSelfContained, manifestText, parseManifest, pluginStates, startPlugins, type BuiltIn, type StartOptions } from "../web/src/plugin-host.ts";
import type { Command, PluginContext, PluginModule, Provider } from "../web/src/plugins.ts";

/** A plugin context that records what's registered, with commands that can be run. */
function host() {
  const commands = new Map<string, Command>();
  const providers: Provider[] = [];
  const ctx = {
    commands: { register: (...cs: Command[]) => cs.forEach((c) => commands.set(c.id, c)), run: (id: string) => (commands.get(id)?.run(), true), all: () => [...commands.values()], shortcut: () => undefined },
    commandBar: { provide: (p: Provider) => providers.push(p), open: () => {} },
    panels: { register: () => {}, toggle: () => {}, show: () => {}, shown: () => null, refresh: () => {} },
    workbench: { provideViews: () => {}, label: (p: string) => p.replace(/\.md$/, ""), openPicked: () => {} },
    events: { onSaved: () => {}, onFocus: () => {} },
    files: { list: () => [{ path: "Plan.md", revision: 1 }] },
    util: { fuzzyFilter: <T>(q: string, items: readonly T[], text: (i: T) => string) => items.filter((i) => text(i).toLowerCase().includes(q.toLowerCase())), notePathFor: (n: string) => (n ? `${n}.md` : null) },
  } as unknown as PluginContext;
  return { ctx, commands, providers };
}

const builtIn = (id: string, module: PluginModule, source = "export default {}"): BuiltIn => ({ id, name: id, description: `${id} does things`, module, source, file: `web/src/plugins/${id}.js` });
const adds = (title: string): PluginModule => ({ activate: (ctx) => ctx.commands.register({ id: title, title, run: () => {} }) });

/** Workspace files for plugins: id → [plugin.json, index.js] texts. */
function workspace(plugins: Record<string, [string, string]>) {
  const texts = new Map<string, string>();
  let revision = 0;
  const files: FileSummary[] = [];
  for (const [id, [json, js]] of Object.entries(plugins)) {
    for (const [name, text] of [["plugin.json", json], ["index.js", js]]) {
      const path = `.common-ink/plugins/${id}/${name}` as FilePath;
      texts.set(path, text);
      files.push({ path, revision: ++revision });
    }
  }
  return { files, read: async (path: FilePath): Promise<WorkspaceFile> => ({ path, text: texts.get(path) ?? "", revision: 1 }), texts };
}

/** Workspace plugin code, "loaded" by evaluating the index.js text as a module, as the browser would. */
async function load(texts: Map<string, string>, id: string): Promise<unknown> {
  const text = texts.get(`.common-ink/plugins/${id}/index.js`)!;
  return import(`data:text/javascript,${encodeURIComponent(text)}`);
}

function options(o: Partial<StartOptions> & Pick<StartOptions, "ctx">): StartOptions {
  return { builtIns: [], files: [], read: async (path) => ({ path, text: "", revision: 0 }), load: async () => ({}), disabled: [], safe: false, changed: () => {}, ...o };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
}

test("built-ins start in order, settings turn one off, and one that throws doesn't stop the rest", async () => {
  const { ctx, commands } = host();
  const broken: PluginModule = {
    activate() {
      throw new Error("broken");
    },
  };
  const entries = await quietly(() =>
    startPlugins(options({ ctx, builtIns: [builtIn("a", adds("A")), builtIn("b", adds("B")), builtIn("broken", broken), builtIn("c", adds("C"))], disabled: ["b"] })),
  );
  assert.deepEqual([...commands.keys()], ["A", "C"]);
  assert.deepEqual(
    entries.map((e) => [e.manifest.id, e.state, e.error ?? null]),
    [
      ["a", "on", null],
      ["b", "off", null],
      ["broken", "failed", "broken"],
      ["c", "on", null],
    ],
  );
  assert.deepEqual(entries[0].contributions, { commands: ["A"], views: [], commandBar: [], keybindings: [], editor: [], history: [], dataSources: [] });
  assert.deepEqual(entries[1].contributions, { commands: ["B"], views: [], commandBar: [], keybindings: [], editor: [], history: [], dataSources: [] }, "a built-in that's off still says what it would add");
});

test("a command that throws is caught and shown on its plugin, not thrown at the app", async () => {
  const { ctx, commands } = host();
  let changed = 0;
  const entries = await startPlugins(
    options({
      ctx,
      changed: () => changed++,
      builtIns: [
        builtIn("oops", {
          activate: (c) =>
            c.commands.register({
              id: "oops.run",
              title: "Oops",
              run: () => {
                throw new Error("nope");
              },
            }),
        }),
      ],
    }),
  );
  await quietly(async () => commands.get("oops.run")!.run());
  assert.equal(entries[0].error, "nope");
  assert.equal(changed, 1);
});

test("a workspace plugin loads from its files and starts after the built-ins", async () => {
  const { ctx, commands } = host();
  const ws = workspace({
    "word-count": ['{"name": "Word count", "description": "Counts words."}', 'export default { activate(ctx) { ctx.commands.register({ id: "wc", title: "Count words", run() {} }); } };'],
  });
  const entries = await startPlugins(options({ ctx, builtIns: [builtIn("a", adds("A"))], files: ws.files, read: ws.read, load: (w) => load(ws.texts, w.id) }));
  assert.deepEqual([...commands.keys()], ["A", "wc"]);
  const wc = entries[1];
  assert.deepEqual(wc.manifest, { id: "word-count", name: "Word count", description: "Counts words." });
  assert.equal(wc.state, "on");
  assert.equal(wc.workspace?.scriptPath, ".common-ink/plugins/word-count/index.js");
});

test("a workspace copy of a built-in runs in its place; safe mode runs the built-in instead", async () => {
  const source = readFileSync("web/src/plugins/command-bar-commands.js", "utf8");
  const original = (await import("../web/src/plugins/command-bar-commands.js")).default as PluginModule;
  const changedSource = source.replace('placeholder: "Run a command"', 'placeholder: "Do something"');
  const ws = workspace({ "commandBar.commands": [manifestText({ id: "commandBar.commands", name: "Command list", description: "Commands." }), changedSource] });
  const b = builtIn("commandBar.commands", original, source);

  const custom = host();
  const entries = await startPlugins(options({ ctx: custom.ctx, builtIns: [b], files: ws.files, read: ws.read, load: (w) => load(ws.texts, w.id) }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "on");
  assert.ok(entries[0].builtIn && entries[0].workspace, "customized");
  assert.equal(custom.providers[0].placeholder, "Do something", "the copy, changed, is what runs");

  const safe = host();
  const safeEntries = await startPlugins(options({ ctx: safe.ctx, builtIns: [b], files: ws.files, read: ws.read, load: () => assert.fail("safe mode loads no workspace code"), safe: true }));
  assert.equal(safe.providers[0].placeholder, "Run a command");
  assert.equal(safeEntries[0].state, "on");
});

test("safe mode lists workspace plugins without loading them", async () => {
  const { ctx } = host();
  const ws = workspace({ mine: ['{"name": "Mine"}', "throw new Error('should not run')"] });
  const entries = await startPlugins(options({ ctx, files: ws.files, read: ws.read, safe: true, load: () => assert.fail("not in safe mode") }));
  assert.deepEqual(
    entries.map((e) => [e.manifest.id, e.state]),
    [["mine", "safe"]],
  );
});

test("a workspace plugin that doesn't load, or doesn't say what it is, fails on its own", async () => {
  const { ctx, commands } = host();
  const ws = workspace({
    bad: ["{oops", "export default { activate() {} };"],
    wrong: ['{"id": "other"}', "export default { activate() {} };"],
    empty: ["{}", "export const nothing = 1;"],
    throws: ["{}", "throw new Error('at load');"],
    fine: ["{}", 'export default { activate(ctx) { ctx.commands.register({ id: "fine", title: "Fine", run() {} }); } };'],
  });
  const entries = await quietly(() => startPlugins(options({ ctx, files: ws.files, read: ws.read, load: (w) => load(ws.texts, w.id) })));
  const byId = Object.fromEntries(entries.map((e) => [e.manifest.id, e]));
  assert.match(byId.bad.error!, /^plugin\.json isn't valid JSON/);
  assert.match(byId.wrong.error!, /says "id": "other", but its folder is wrong/);
  assert.equal(byId.empty.error, "index.js must export default { activate(ctx) { … } }");
  assert.match(byId.throws.error!, /^index\.js didn't load: at load/);
  assert.equal(byId.fine.state, "on");
  assert.deepEqual([...commands.keys()], ["fine"]);
});

test("turning a plugin on or off, or changing its files, needs a reload; nothing else does", () => {
  const b = [builtIn("history", adds("H"))];
  const files: FileSummary[] = [
    { path: ".common-ink/plugins/mine/plugin.json" as FilePath, revision: 3 },
    { path: ".common-ink/plugins/mine/index.js" as FilePath, revision: 4 },
    { path: "Plan.md" as FilePath, revision: 5 },
  ];
  const start = pluginStates(b, files, [], false);
  assert.deepEqual(changedPlugins(start, pluginStates(b, [...files.slice(0, 2), { path: "Plan.md" as FilePath, revision: 9 }], [], false)), new Set());
  assert.deepEqual(changedPlugins(start, pluginStates(b, files, ["history"], false)), new Set(["history"]));
  assert.deepEqual(changedPlugins(start, pluginStates(b, [files[0], { ...files[1], revision: 8 }], [], false)), new Set(["mine"]));
  assert.deepEqual(changedPlugins(start, pluginStates(b, [], [], false)), new Set(["mine"]), "deleting a plugin");
  const customized = [...files, { path: ".common-ink/plugins/history/plugin.json" as FilePath, revision: 10 }];
  assert.deepEqual(changedPlugins(start, pluginStates(b, customized, [], false)), new Set(["history"]), "customizing a built-in");
  assert.deepEqual(changedPlugins(pluginStates(b, files, [], true), pluginStates(b, customized, [], true)), new Set(), "safe mode doesn't load workspace files");
});

test("plugin.json gives the name and description, from the folder's id", () => {
  assert.deepEqual(parseManifest('{"name": "Mine", "description": "Does it."}', "mine"), { id: "mine", name: "Mine", description: "Does it." });
  assert.deepEqual(parseManifest("{}", "mine"), { id: "mine", name: "mine", description: "" });
  assert.equal(parseManifest('{"name": 3}', "mine"), '"name" must be a string');
  assert.deepEqual(JSON.parse(manifestText({ id: "a", name: "A", description: "B" })), { id: "a", name: "A", description: "B" });
});

test("the command bar built-ins are self-contained, so a copy of one runs on its own; history isn't", async () => {
  for (const file of ["command-bar-notes.js", "command-bar-commands.js"]) {
    const source = readFileSync(`web/src/plugins/${file}`, "utf8");
    assert.ok(isSelfContained(source), file);
    const { ctx, providers } = host();
    const copy = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default as PluginModule;
    copy.activate(ctx);
    assert.equal(providers.length, 1, file);
  }
  const { ctx, providers } = host();
  const notes = (await import("../web/src/plugins/command-bar-notes.js")).default as PluginModule;
  notes.activate(ctx);
  assert.deepEqual(
    providers[0].items("pla").map((i) => i.label),
    ["Plan", "New note: pla"],
  );
  assert.deepEqual(
    providers[0].items("Idea").map((i) => i.label),
    ["New note: Idea"],
  );
  assert.ok(!isSelfContained(readFileSync("web/src/plugins/history.ts", "utf8")));
});

test("a dry run finds what a plugin adds without anything taking effect", () => {
  const simple: PluginModule = {
    activate(ctx) {
      ctx.panels.register({ id: "p", title: "Panel", render: () => {} });
      ctx.commandBar.provide({ prefix: "#", placeholder: "", items: () => [] });
      ctx.commands.register({ id: "x", title: "X", run: () => {} });
    },
  };
  assert.deepEqual(dryRun(simple), { commands: ["X"], views: ["Panel"], commandBar: ["#"], keybindings: [], editor: [], history: [], dataSources: [] });
});
