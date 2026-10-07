import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import type { FilePath, FileSummary, WorkspaceFile } from "../worker/src/files.ts";
import { combine, describeSchema, parseSettings, settingsCatalog } from "../worker/src/settings.ts";
import type { ExtensionContext, ExtensionModule } from "../web/src/extension-api.ts";
import { changedExtensions, extensionStates, ExtensionHost, findWorkspaceExtensions, forbiddenImports, type BuiltIn } from "../web/src/extension-host.ts";
import { APP_MODULES, LIBRARY_NAMES } from "../web/src/library-names.ts";
import { contributionLines } from "../web/src/extensions-view.ts";
import { declaredPermissions, plain } from "../web/src/permission-words.ts";

const manifest = (id: string, more: Record<string, unknown> = {}) => {
  const m = parseManifest({ name: id, version: "1.0.0", ...more }, id);
  if (typeof m === "string") throw new Error(m);
  return m;
};

const builtIn = (id: string, module: ExtensionModule, more: Record<string, unknown> = {}): BuiltIn => ({
  manifest: manifest(id, more),
  load: async () => module,
  files: ["index.js"],
  source: async () => "export default { activate() {} };",
  copy: async () => ({ "index.js": "export default { activate() {} };" }),
  folder: `web/src/extensions/${id}`,
});

/** A laptop, as the runtime reads devices: wide, a mouse, a keyboard. */
const laptop = {
  facts: { width: "large", px: 1440, pointer: "fine", touch: false, keyboard: true },
  override: () => undefined,
  has: () => true,
  atLeast: () => true,
  why: () => "",
  onChange: () => () => {},
  describe: () => ({}),
} as never;

/** A host whose context records what extensions do, and which starts nothing until told. */
function host() {
  const started: string[] = [];
  const failures: string[] = [];
  const h = new ExtensionHost({
    context: (record, failed) => ({ extension: record.manifest, failed }) as unknown as ExtensionContext,
    load: async () => ({}),
    sandbox: async (record) => void started.push(`${record.id} (sandboxed)`),
    changed: () => {},
  });
  const starts = (id: string): ExtensionModule => ({ activate: () => void started.push(id) });
  return { h, started, failures, starts };
}

const read = (texts: Record<string, string>) => async (path: FilePath): Promise<WorkspaceFile> => ({ path, text: texts[path] ?? "", revision: 1 });
const summaries = (paths: string[]): FileSummary[] => paths.map((path, i) => ({ path: path as FilePath, revision: i + 1 }));

test("a manifest says what an extension adds and may ask for, with defaults for what it leaves out", () => {
  const m = manifest("weather", {
    description: "Forecasts in a view.",
    activationEvents: ["onView:forecast", "onCommand:weather.refresh"],
    permissions: { network: { hosts: ["api.weather.gov"], why: "Fetch forecasts" }, "files:read": { paths: ["Journal/**"], why: "Read your journal" } },
    contributes: {
      commands: [{ command: "weather.refresh", title: "Refresh the forecast" }],
      keybindings: [{ key: "Mod-Shift-w", command: "weather.refresh" }, { vim: "gW", command: "weather.refresh" }],
      menus: { tabMenu: [{ command: "weather.refresh" }] },
      views: { sidebar: [{ id: "forecast", name: "Forecast" }] },
      configuration: { title: "Weather", properties: { "weather.units": { type: "string", enum: ["metric", "imperial"], default: "metric", description: "Units." } } },
    },
  });
  assert.equal(m.main, "index.js");
  assert.deepEqual(m.files, ["index.js"]);
  assert.deepEqual(m.permissions.network, { why: "Fetch forecasts", hosts: ["api.weather.gov"] });
  assert.deepEqual(contributionLines(m), [
    ["Commands", "Refresh the forecast"],
    ["Keybindings", "Mod-Shift-w → Refresh the forecast, gW (Vim) → Refresh the forecast"],
    ["Menus", "Refresh the forecast (tab menu)"],
    ["Views", "Forecast"],
    ["Settings", "weather.units"],
  ]);
  assert.deepEqual(
    declaredPermissions(m).map((p) => [p.key, plain(p.can), p.why]),
    [
      ["network:api.weather.gov", "Connect to api.weather.gov", "Fetch forecasts"],
      ["files:read:Journal/**", "Read everything in Journal", "Read your journal"],
    ],
  );
  assert.deepEqual(manifest("bare").activationEvents, ["onStartup"]);
});

test("a manifest that's wrong says what's wrong with it", () => {
  const wrong = (data: Record<string, unknown>, id = "x") => parseManifest(data, id);
  assert.equal(wrong({ id: "y" }), 'extension.json says "id": "y", but its folder is x');
  assert.equal(parseManifest("{oops", "x").toString().startsWith("extension.json isn't valid JSON"), true);
  assert.match(wrong({ permissions: { camera: { why: "Smile" } } }) as string, /^permissions\["camera"\] isn't a permission/);
  assert.equal(wrong({ permissions: { network: { why: "Talk" } } }), 'permissions["network"].hosts must name hosts, like "api.weather.gov" or "*.example.com", or be "*" for any');
  assert.equal(wrong({ permissions: { network: { hosts: ["http://evil.example"], why: "Talk" } } }), 'permissions["network"].hosts must name hosts, like "api.weather.gov" or "*.example.com", or be "*" for any; "http://evil.example" isn\'t one');
  assert.equal(wrong({ permissions: { "files:read": { paths: ["**"] } } }), 'permissions["files:read"].why must be text');
  assert.equal(wrong({ permissions: { "files:read": { paths: ["!Secret/**"], why: "x" } } }), 'permissions["files:read"].paths are the files it may touch, so none starts with "!": "!Secret/**" does');
  assert.equal(wrong({ contributes: { configuration: { properties: { "other.thing": { type: "boolean" } } } } }), 'Setting "other.thing" must start with "x."');
  assert.equal(wrong({ main: "../escape.js" }), '"main" must be a file in the extension\'s folder, like "index.js"');
  assert.equal(wrong({ main: "index.ts" }), '"main" must be a file in the extension\'s folder, like "index.js"', "only built-ins are compiled");
  assert.match(wrong({ activationEvents: ["whenever"] }) as string, /^"activationEvents"\[0\] isn't an activation event/);
  assert.equal(wrong({}, "../up"), `"../up" can't be an extension's id: letters, digits, dots, dashes and underscores`);
  assert.equal(wrong({ contributes: { search: { types: [{ type: "note", title: "Mine" }] } } }), 'contributes.search.types[0].type must be lowercase letters and dashes, and not "note"');
  assert.equal(wrong({ contributes: { search: { filters: [{ filter: "is:", values: [] }] } } }), 'contributes.search.filters[0].filter must be a word like "due:", and not one of is, in, from, type, edited, has, sort, http, https, www, ftp, mailto, file, note');
  assert.match(wrong({ contributes: { search: { filters: [{ filter: "https", values: [] }] } } }) as string, /not one of/);
});

test("a manifest's search contribution names its kinds of result and its filters, without their colons", () => {
  const m = parseManifest({ name: "x", version: "1", contributes: { search: { types: [{ type: "event", title: "Events" }], filters: [{ filter: "On:", description: "A day", values: ["today"] }] } } }, "x");
  assert.deepEqual(typeof m === "string" ? m : m.contributes.search, { types: [{ type: "event", title: "Events" }], filters: [{ filter: "on", description: "A day", values: ["today"] }] });
});

test("every built-in's extension.json is valid, and lists files that are there", () => {
  const root = "web/src/extensions";
  const ids = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(ids.length >= 7);
  for (const id of ids) {
    const m = parseManifest(readFileSync(`${root}/${id}/extension.json`, "utf8"), id, { builtIn: true });
    assert.equal(typeof m, "object", `${id}: ${m}`);
    for (const file of (m as ExtensionManifest).files) assert.ok(readdirSync(`${root}/${id}`).includes(file), `${id} lists ${file}`);
  }
});

test("built-ins start on their activation events, not before; one that throws fails alone", async () => {
  const { h, started, starts } = host();
  const broken: ExtensionModule = {
    activate() {
      throw new Error("broken");
    },
  };
  await h.load(
    [
      builtIn("a", starts("a")),
      builtIn("lazy", starts("lazy"), { activationEvents: ["onCommand:lazy.go"] }),
      builtIn("off", starts("off")),
      builtIn("broken", broken),
    ],
    [],
    read({}),
    ["off"],
    false,
  );
  assert.deepEqual(h.records.map((r) => [r.id, r.state]), [["a", "inactive"], ["lazy", "inactive"], ["off", "off"], ["broken", "inactive"]]);
  await h.fire("onStartup");
  assert.deepEqual(started, ["a"]);
  assert.deepEqual(h.records.map((r) => [r.id, r.state, r.error ?? null]), [["a", "active", null], ["lazy", "inactive", null], ["off", "off", null], ["broken", "failed", "broken"]]);
  await h.fire("onCommand:lazy.go");
  await h.fire("onCommand:lazy.go");
  assert.deepEqual(started, ["a", "lazy"], "started once");
  assert.deepEqual(h.on().map((m) => m.id), ["a", "lazy"], "a failed extension's contributions are taken out");
});

test("a workspace extension is read from its folder; one with a built-in's id replaces it, except in safe mode", async () => {
  const files = summaries([
    ".common-ink/extensions/reading-time/extension.json",
    ".common-ink/extensions/reading-time/index.js",
    ".common-ink/extensions/a/extension.json",
    ".common-ink/extensions/a/index.js",
    ".common-ink/extensions/a/lib/util.js",
    ".common-ink/extensions/bad/extension.json",
    ".common-ink/extensions/no-manifest/index.js",
    "Plan.md",
  ]);
  assert.deepEqual(
    findWorkspaceExtensions(files).map((w) => [w.id, w.files.length]),
    [["reading-time", 2], ["a", 3], ["bad", 1]],
  );
  const texts = {
    ".common-ink/extensions/reading-time/extension.json": '{"name": "Reading time", "version": "1.2.0"}',
    ".common-ink/extensions/a/extension.json": '{"name": "A, customized"}',
    ".common-ink/extensions/bad/extension.json": "{oops",
  };
  const { h } = host();
  await h.load([builtIn("a", { activate() {} })], files, read(texts), [], false);
  assert.deepEqual(
    h.records.map((r) => [r.id, r.manifest.name, r.state, !!r.builtIn, !!r.workspace]),
    [["reading-time", "Reading time", "inactive", false, true], ["a", "A, customized", "inactive", true, true], ["bad", "bad", "failed", false, true]],
  );
  assert.match(h.records[2].error!, /^extension\.json isn't valid JSON/);
  assert.deepEqual(h.installed().map((m) => m.id), ["reading-time", "a"], "a broken manifest adds nothing");

  const safe = host();
  await safe.h.load([builtIn("a", { activate() {} })], files, read(texts), [], true);
  assert.deepEqual(
    safe.h.records.map((r) => [r.id, r.manifest.name, r.state]),
    [["a", "a", "inactive"], ["reading-time", "Reading time", "safe"], ["bad", "bad", "failed"]],
  );
});

test("an extension installed from a URL or a catalog says so, and who made it", async () => {
  const { originOf } = await import("../web/src/extensions-view.ts");
  const files = summaries([
    ".common-ink/extensions/weather/extension.json",
    ".common-ink/extensions/weather/installed.json",
    ".common-ink/extensions/mine/extension.json",
    ".common-ink/extensions/reading-time/extension.json",
    ".common-ink/extensions/reading-time/installed.json",
  ]);
  const texts = {
    ".common-ink/extensions/weather/extension.json": '{"name": "Weather", "publisher": "Weather Co."}',
    ".common-ink/extensions/weather/installed.json": '{"from": "https://ext.example/weather/extension.json"}',
    ".common-ink/extensions/mine/extension.json": "{}",
    ".common-ink/extensions/reading-time/extension.json": '{"name": "Reading time", "publisher": "Common Ink"}',
    ".common-ink/extensions/reading-time/installed.json": '{"from": "https://app.example/catalog/reading-time/extension.json", "catalog": "Common Ink"}',
  };
  const { h } = host();
  await h.load([builtIn("a", { activate() {} })], files, read(texts), [], false);
  assert.deepEqual(
    h.records.map((r) => [r.id, originOf(r), r.installedFrom ?? null, r.manifest.publisher ?? null]),
    [
      ["a", "Built-in", null, null],
      ["weather", "From URL", "https://ext.example/weather/extension.json", "Weather Co."],
      ["mine", "Workspace", null, null],
      ["reading-time", "Catalog", "https://app.example/catalog/reading-time/extension.json", "Common Ink"],
    ],
  );
});

test("Word count, taken out of the Catalog, no longer runs or shows where it was installed from it; one you wrote of that id does", async () => {
  const fromCatalog = summaries([".common-ink/extensions/word-count/extension.json", ".common-ink/extensions/word-count/index.js", ".common-ink/extensions/word-count/installed.json"]);
  const texts = {
    ".common-ink/extensions/word-count/extension.json": '{"name": "Word count", "publisher": "Common Ink"}',
    ".common-ink/extensions/word-count/installed.json": '{"from": "https://app.example/catalog/word-count/extension.json", "catalog": "Common Ink"}',
  };
  const { h } = host();
  await h.load([builtIn("words", { activate() {} })], fromCatalog, read(texts), [], false);
  assert.deepEqual(h.installed().map((m) => m.id), ["words"]);
  const added = await h.add(findWorkspaceExtensions(fromCatalog)[0], read(texts));
  assert.equal(added, null, "nor when it's put in while the app runs");

  const yours = summaries([".common-ink/extensions/word-count/extension.json", ".common-ink/extensions/word-count/index.js"]);
  const { h: h2 } = host();
  await h2.load([builtIn("words", { activate() {} })], yours, read(texts), [], false);
  assert.deepEqual(h2.installed().map((m) => m.id), ["words", "word-count"]);
});

test("a workspace extension runs sandboxed unless you trust it; built-ins run in the page", async () => {
  const files = summaries([".common-ink/extensions/mine/extension.json", ".common-ink/extensions/mine/index.js", ".common-ink/extensions/yours/extension.json"]);
  const texts = { ".common-ink/extensions/mine/extension.json": "{}", ".common-ink/extensions/yours/extension.json": "{}" };
  const { h, started } = host();
  await h.load([builtIn("a", { activate: () => void started.push("a") })], files, read(texts), [], false, ["yours"]);
  assert.deepEqual(h.records.map((r) => [r.id, r.tier]), [["a", "page"], ["mine", "sandbox"], ["yours", "page"]]);
  await h.activate(h.records[1]);
  assert.deepEqual(started, ["mine (sandboxed)"]);
});

test("turning an extension on or off, or changing any of its files, needs a reload; nothing else does", () => {
  const b = [builtIn("history", { activate() {} })];
  const files = summaries([".common-ink/extensions/mine/extension.json", ".common-ink/extensions/mine/index.js", "Plan.md"]);
  const start = extensionStates(b, files, [], false);
  assert.deepEqual(changedExtensions(start, extensionStates(b, [...files.slice(0, 2), { path: "Plan.md" as FilePath, revision: 9 }], [], false)), new Set());
  assert.deepEqual(changedExtensions(start, extensionStates(b, files, ["history"], false)), new Set(["history"]));
  assert.deepEqual(changedExtensions(start, extensionStates(b, [files[0], { ...files[1], revision: 8 }, files[2]], [], false)), new Set(["mine"]));
  assert.deepEqual(changedExtensions(start, extensionStates(b, files.slice(2), [], false)), new Set(["mine"]), "uninstalling");
});

test("built-ins import only their own files and the libraries, so a copy of any of them runs on its own", async () => {
  assert.deepEqual(forbiddenImports('import { x } from "./model.js";\nimport type { Y } from "../../app.ts";\nimport { Decoration } from "@codemirror/view";', LIBRARY_NAMES), []);
  assert.deepEqual(forbiddenImports('import { x } from "../../keys.ts";\nimport "lodash";', LIBRARY_NAMES), ["../../keys.ts", "lodash"]);
  const root = "web/src/extensions";
  for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const file of readdirSync(`${root}/${id}`).filter((f) => /\.(ts|js)$/.test(f))) {
      assert.deepEqual(forbiddenImports(readFileSync(`${root}/${id}/${file}`, "utf8"), LIBRARY_NAMES), [], `${id}/${file}`);
    }
  }
  // The app modules offered as libraries export what library-names.ts says, which the /lib/ modules hand over.
  for (const [name, { file, exports }] of Object.entries(APP_MODULES)) assert.deepEqual(Object.keys(await import(`../${file}`)).sort(), [...exports].sort(), name);
});

test("an extension's settings join the catalog in its own section, checked against its schema", () => {
  const weather = manifest("weather", {
    contributes: {
      configuration: {
        title: "Weather",
        properties: {
          "weather.units": { type: "string", enum: ["metric", "imperial"], default: "metric", description: "Units." },
          "weather.days": { type: "integer", minimum: 1, maximum: 10, default: 3, description: "Days ahead." },
        },
      },
    },
  });
  const catalog = settingsCatalog([weather]);
  assert.equal(catalog.get("weather.units")?.section, "Weather");
  assert.equal(catalog.get("weather.units")?.extension, "weather");
  assert.equal(catalog.get("editor.lineNumbers")?.section, "Editor");
  assert.deepEqual(parseSettings('{"weather.units": "kelvin", "weather.days": 4, "editor.lineNumbers": true}', catalog), {
    settings: { "weather.days": 4, "editor.lineNumbers": true },
    problems: ['"weather.units" must be one of "metric", "imperial"'],
  });
  assert.deepEqual(parseSettings('{"weather.days": 4}').problems, ['Unknown setting "weather.days"'], "unknown without its extension");
  const settings = combine({ "weather.days": 5 }, {}, [], catalog);
  assert.equal(settings["weather.units"], "metric", "defaults come from the manifest");
  assert.equal(settings["weather.days"], 5);
  assert.equal(describeSchema({ type: "integer", minimum: 1 }), "a whole number of at least 1");
  assert.match(parseSettings('{"editor.vim": false}').problems[0], /Vim keys are the Vim extension now/, "a setting that moved says where it went");
});

test("in the app, a declared command starts its extension the first time it runs; undeclared ones are refused", async () => {
  const { Commands } = await import("../web/src/commands.ts");
  const { ExtensionRuntime } = await import("../web/src/extension-runtime.ts");
  const { DEFAULTS } = await import("../worker/src/settings.ts");
  const ran: string[] = [];
  const views = new Map<string, { render(el: unknown): unknown }>();
  const commands = new Commands();
  const quiet = console.error;
  console.error = () => {};
  const runtime = new ExtensionRuntime({
    me: "you@example.com",
    commands,
    bar: { provide() {}, open() {} } as never,
    search: { provide() {}, find: async () => [], extraKeys: () => [] } as never,
    onChange: [],
    panels: { register: (v: { id: string; render(el: unknown): unknown }) => views.set(v.id, v), toggle() {}, show() {}, shown: () => null, refresh() {} } as never,
    workbench: { registerView() {}, openView() {}, provideViews() {}, refreshView() {}, extend() {}, notice: (m: string) => ran.push(`notice: ${m}`) } as never,
    offline: { read: async () => ({ text: "", revision: 0 }) } as never,
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
    device: laptop,
    promoted() {},
  });
  const greet: ExtensionModule = {
    activate(ctx) {
      ran.push("started");
      ctx.commands.register("greet.hello", () => ran.push("hello"));
      ctx.views.register("greeting", { render: () => void ran.push("drawn") });
      ctx.commands.register("greet.secret", () => ran.push("secret"));
    },
  };
  const m = {
    activationEvents: ["onCommand:greet.hello"],
    contributes: {
      commands: [{ command: "greet.hello", title: "Say hello" }],
      keybindings: [{ vim: "gH", command: "greet.hello" }],
      views: { sidebar: [{ id: "greeting", name: "Greeting" }] },
    },
  };
  await runtime.load([builtIn("greet", greet, m)], [], [], false, []);
  runtime.declare();
  await runtime.start();
  assert.deepEqual(ran, [], "declared, not started");
  assert.deepEqual(
    runtime.allKeybindings().filter((k) => k.command.startsWith("greet.")),
    [{ command: "greet.hello", vim: "gH" }],
    "its Vim sequence is there for the Vim extension to map",
  );
  assert.deepEqual(commands.all().map((c) => c.title), ["Open Greeting in a window", "Say hello"]);
  commands.run("greet.hello");
  await new Promise((r) => setTimeout(r, 0));
  console.error = quiet;
  assert.deepEqual(ran, ["started", "hello"]);
  const record = runtime.host.records[0];
  assert.equal(record.state, "failed", "registering an undeclared command fails it");
  assert.equal(record.error, `Command "greet.secret" isn't declared in greet's contributes.commands`);
});

test("the app's catalog lists folders on the app only", async () => {
  const { parseCatalog } = await import("../worker/src/catalog.ts");
  const index = JSON.parse(readFileSync("web/public/catalog/index.json", "utf8"));
  const entries = parseCatalog(index, "https://app.example/catalog/index.json", true);
  assert.deepEqual(
    entries.map((e) => [e.id, e.folder, e.catalog, e.firstParty]),
    ["boards", "pomodoro", "html-app"].map((id) => [id, `https://app.example/catalog/${id}/`, "Common Ink", true]),
  );
  for (const e of entries) {
    const m = parseManifest(JSON.parse(readFileSync(`web/public/catalog/${e.id}/extension.json`, "utf8")), e.id);
    assert.notEqual(typeof m, "string", `${e.id}'s extension.json is valid`);
    for (const file of (m as ExtensionManifest).files) assert.ok(readFileSync(`web/public/catalog/${e.id}/${file}`, "utf8"), `${e.id}/${file} is there`);
  }
  assert.deepEqual(parseCatalog({ extensions: [{ id: "far", name: "Far", path: "https://elsewhere.example/far/" }] }, "https://app.example/catalog/index.json", true), [], "not another site's");
});

test("a built-in allowed to copy writes the clipboard in the click itself, before anything waits", async () => {
  const { Commands } = await import("../web/src/commands.ts");
  const { ExtensionRuntime } = await import("../web/src/extension-runtime.ts");
  const { DEFAULTS } = await import("../worker/src/settings.ts");
  const runtime = new ExtensionRuntime({
    me: "you@example.com",
    commands: new Commands(),
    bar: { provide() {}, open() {} } as never,
    search: { provide() {}, find: async () => [], extraKeys: () => [] } as never,
    onChange: [],
    panels: { register() {}, toggle() {}, show() {}, shown: () => null, refresh() {} } as never,
    workbench: { registerView() {}, openView() {}, provideViews() {}, refreshView() {}, extend() {}, notice() {} } as never,
    offline: { read: async () => ({ text: "", revision: 0 }) } as never,
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
    device: laptop,
    promoted() {},
  });
  let ctx!: ExtensionContext;
  await runtime.load([builtIn("copier", { activate: (c) => void (ctx = c) }, { activationEvents: ["onStartup"], permissions: { "clipboard:write": { why: "Copy" } } })], [], [], false, []);
  runtime.declare();
  await runtime.start();
  const written: string[] = [];
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => void written.push(t) } }, configurable: true });
  try {
    const done = ctx.clipboard.write("some code");
    assert.deepEqual(written, ["some code"], "written already, with nothing awaited first");
    await done;
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
  }
});

test("an extension's activate can return an API; another gets it by id, starting it first, and nothing from one that's off", async () => {
  const { h } = host();
  const daily: ExtensionModule = { activate: () => ({ pathFor: (day: string) => `Journal/${day}.md` }) };
  await h.load([builtIn("daily", daily, { activationEvents: ["onCommand:daily.today"] }), builtIn("off", { activate: () => ({ x: 1 }) })], [], read({}), ["off"], false);
  assert.equal(h.records[0].state, "inactive");
  const api = (await h.api("daily")) as { pathFor(day: string): string };
  assert.equal(h.records[0].state, "active", "asking for its API starts it");
  assert.equal(api.pathFor("2026-10-05"), "Journal/2026-10-05.md");
  assert.equal(await h.api("off"), undefined, "an extension that's off has none");
  assert.equal(await h.api("nobody"), undefined);
});
