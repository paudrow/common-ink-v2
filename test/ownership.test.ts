// One rule for every name extensions register things under (web/src/ownership.ts), checked kind by kind:
// a trusted extension that's off on a phone owns what it declares from load, so a sandboxed one that
// declares the same name is refused, before the trusted one goes in and after.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath, FileSummary } from "../worker/src/files.ts";
import { DEFAULTS } from "../worker/src/settings.ts";
import type { NameKind } from "../web/src/ownership.ts";

/** For each kind of name: one both extensions declare, and the manifest part that declares it. A new kind fails to typecheck here until it has a row. */
const CASES: Record<NameKind, { name: string; contributes: Record<string, unknown> }> = {
  command: { name: "wordCount.go", contributes: { commands: [{ command: "wordCount.go", title: "Go" }] } },
  view: { name: "wordCount", contributes: { views: { sidebar: [{ id: "wordCount", name: "Counts" }] } } },
  embed: { name: "wordcount", contributes: { embeds: [{ language: "wordcount", title: "Count", description: "" }] } },
  statusItem: { name: "vim.mode", contributes: { statusBarItems: [{ id: "vim.mode", alignment: "left" }] } },
  searchType: { name: "word-count", contributes: { search: { types: [{ type: "word-count", title: "Counts" }] } } },
  prefix: { name: "wordcount", contributes: {} },
};

async function runtimeWith(contributes: Record<string, unknown>) {
  const { Commands } = await import("../web/src/commands.ts");
  const { ExtensionRuntime } = await import("../web/src/extension-runtime.ts");
  const facts = { width: "compact", px: 375, pointer: "coarse", touch: true, keyboard: false };
  const views = new Map<string, unknown>();
  const manifests: Record<string, unknown> = {
    wordCount: { name: "Word count", requires: { keyboard: true }, contributes },
    "word-count": { name: "Word count (sandboxed)", activationEvents: ["onStartup"], contributes },
  };
  const runtime = new ExtensionRuntime({
    me: "you@example.com",
    commands: new Commands(),
    bar: { provide() {}, open() {} } as never,
    search: { provide() {}, find: async () => [], extraKeys: () => [], ownerOf: () => undefined } as never,
    onChange: [],
    panels: { register() {}, toggle() {}, show() {}, shown: () => null, refresh() {} } as never,
    workbench: { registerView: (v: { id: string }) => views.set(v.id, v), view: (id: string) => views.get(id), viewIds: () => [...views.keys()], openView() {}, provideViews() {}, refreshView() {}, extend() {}, notice() {} } as never,
    offline: { read: async (path: string) => ({ path, text: JSON.stringify(manifests[path.split("/")[2]]), revision: 1 }) } as never,
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
    device: { facts, override: () => undefined, has: (c: string) => (c === "keyboard" ? facts.keyboard : facts.touch), atLeast: () => true, why: () => "", onChange: () => () => {}, describe: () => ({ facts, why: {} }) } as never,
    promoted() {},
  });
  const files = Object.keys(manifests).map((id) => ({ path: `.common-ink/extensions/${id}/extension.json` as FilePath, revision: 1 }) as FileSummary);
  await runtime.load([], files, [], false, ["wordCount"]);
  runtime.declare();
  return { runtime, findKeyboard: () => void (facts.keyboard = true) };
}

for (const [kind, { name, contributes }] of Object.entries(CASES) as Array<[NameKind, (typeof CASES)[NameKind]]>) {
  test(`${kind}: a trusted extension off on a phone owns "${name}" from load; a sandboxed one that declares it is refused, before the trusted one goes in and after`, async () => {
    const { runtime, findKeyboard } = await runtimeWith(contributes);
    const registry = runtime.ownership.registry<string>(kind);
    const state = (id: string) => runtime.host.records.find((r) => r.id === id)?.state;
    assert.deepEqual([state("wordCount"), state("word-count")], ["unmet", "inactive"], "setup: the trusted one is off here, the sandboxed one is on");
    assert.equal(runtime.ownership.owner(kind, name), "wordCount");
    assert.equal(registry.set("word-count", name, "sandboxed"), false, "the sandboxed one can't register under it");
    findKeyboard();
    await runtime.promote();
    assert.notEqual(state("wordCount"), "unmet", "the trusted one went in");
    assert.equal(runtime.ownership.owner(kind, name), "wordCount");
    assert.equal(registry.set("word-count", name, "sandboxed"), false);
    assert.equal(registry.set("wordCount", name, "trusted"), true);
    assert.equal(registry.get(name), "trusted");
  });
}

test("what a sandboxed extension registered under a name it owned is no longer found once a trusted extension declares the name", async () => {
  const { Ownership } = await import("../web/src/ownership.ts");
  const records = [{ id: "word-count", tier: "sandbox", state: "active", manifest: { id: "word-count", contributes: CASES.command.contributes } }] as never[];
  const ownership = new Ownership(() => records);
  const handlers = ownership.registry<string>("command");
  assert.equal(handlers.set("word-count", "wordCount.go", "sandboxed"), true);
  assert.equal(handlers.get("wordCount.go"), "sandboxed");
  records.push({ id: "wordCount", tier: "page", state: "inactive", manifest: { id: "wordCount", contributes: CASES.command.contributes } } as never);
  assert.equal(handlers.get("wordCount.go"), undefined);
});

test("in the page, a built-in keeps its own names, one turned off holds none, and the first listed keeps a name two others declare", async () => {
  const { Ownership } = await import("../web/src/ownership.ts");
  const declares = CASES.command.contributes;
  const rec = (id: string, more: Record<string, unknown> = {}) => ({ id, tier: "page", state: "inactive", manifest: { id, contributes: declares }, ...more });
  const owner = (records: unknown[]) => new Ownership(() => records as never).owner("command", "wordCount.go");
  assert.equal(owner([rec("lists", { builtIn: {} }), rec("helper")]), "lists");
  assert.equal(owner([rec("helper"), rec("lists", { builtIn: {} })]), "lists");
  assert.equal(owner([rec("alpha"), rec("beta")]), "alpha");
  assert.equal(owner([rec("alpha", { state: "off" }), rec("beta")]), "beta");
  assert.equal(owner([rec("alpha", { state: "unmet" }), rec("beta")]), "alpha", "off on this device, it still holds its names");
  assert.equal(owner([rec("alpha", { state: "off" })]), undefined);
});
