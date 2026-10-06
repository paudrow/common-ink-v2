import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deviceName, devicePath, here, hereText, needsText, parseDeviceFile, unmet, widthClassOf, type Facts } from "../worker/src/devices.ts";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import { fromHardware } from "../web/src/device.ts";
import { DEFAULTS } from "../worker/src/settings.ts";
import type { ExtensionContext, ExtensionModule } from "../web/src/extension-api.ts";
import type { BuiltIn } from "../web/src/extension-host.ts";

const phone: Facts = { width: "compact", px: 375, pointer: "coarse", touch: true, keyboard: false };
const laptop: Facts = { width: "large", px: 1440, pointer: "fine", touch: false, keyboard: true };

test("width classes start at 600, 840 and 1200 pixels", () => {
  assert.deepEqual([0, 599, 600, 839, 840, 1199, 1200, 2560].map(widthClassOf), ["compact", "compact", "medium", "medium", "expanded", "expanded", "large", "large"]);
});

test("what a device doesn't meet is said in words, in the order a manifest's needs are read", () => {
  const needs = unmet({ keyboard: true, width: "medium", pointer: "fine" }, phone);
  assert.equal(needsText(needs), "needs a keyboard, a screen 600px wide and a mouse or trackpad");
  assert.deepEqual(unmet({ keyboard: true, width: "medium", pointer: "fine" }, laptop), []);
  assert.deepEqual(unmet(undefined, phone), []);
});

test("on here: your override for the device comes first, then what it needs", () => {
  const vim = { keyboard: true } as const;
  assert.equal(hereText(here(vim, phone)), "Off on this device · needs a keyboard");
  assert.equal(hereText(here(vim, laptop)), null, "simply on");
  assert.equal(hereText(here(vim, phone, "on")), "On here · you turned it on; it needs a keyboard");
  assert.equal(here(vim, phone, "on").on, true);
  assert.equal(hereText(here(vim, laptop, "off")), "Off on this device · you turned it off here");
  assert.equal(here(undefined, laptop, "off").on, false, "off here even with nothing to need");
});

test("a device file is read as far as it makes sense; the rest is worked out again", () => {
  assert.deepEqual(parseDeviceFile("not json"), {});
  assert.deepEqual(parseDeviceFile("[]"), {});
  assert.deepEqual(
    parseDeviceFile(JSON.stringify({ name: "iPhone · Safari", keyboard: "maybe", seen: { width: "huge", keyboard: true }, extensions: { vim: "on", lists: "sometimes" } })),
    { name: "iPhone · Safari", seen: { width: "compact", pointer: "coarse", touch: false, keyboard: true }, extensions: { vim: "on" } },
  );
  assert.equal(devicePath("you@example.com", "3fa9c1d2e0b4"), ".common-ink/users/you@example.com/devices/3fa9c1d2e0b4/device.json");
  assert.equal(devicePath("you@example.com", "../settings"), null, "an id is a folder's name, and nothing else");
});

test("a device is named for its system and browser", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const pixel = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  assert.deepEqual([iphone, mac, pixel].map(deviceName), ["iPhone · Safari", "Mac · Chrome", "Android phone · Chrome"]);
});

test("a keyboard is found from a key no touch screen's keyboard sends", () => {
  const key = (k: string, more: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ key: k, ctrlKey: false, metaKey: false, isComposing: false, ...more });
  assert.equal(fromHardware(key("j"), false), true, "any key outside a text field");
  assert.equal(fromHardware(key("j"), true), false, "a letter typed into a note may be the on-screen keyboard's");
  assert.equal(fromHardware(key("Backspace"), true), false);
  assert.equal(fromHardware(key("Escape"), true), true);
  assert.equal(fromHardware(key("ArrowDown"), true), true);
  assert.equal(fromHardware(key("k", { metaKey: true }), true), true, "a ⌘ or Ctrl chord");
  assert.equal(fromHardware(key("Meta", { metaKey: true }), true), false, "not ⌘ alone");
  assert.equal(fromHardware(key("Unidentified"), false), false, "Android's on-screen keyboard");
  assert.equal(fromHardware({ ...key("a"), isComposing: true }, false), false);
});

test("a manifest says what an extension and each contribution need; anything a device can't have is refused", () => {
  const m = parseManifest(
    {
      requires: { keyboard: true },
      contributes: {
        commands: [{ command: "w.beside", title: "Open beside", requires: { width: "expanded" } }],
        views: { sidebar: [{ id: "w.map", name: "Map", requires: { pointer: "fine" } }] },
      },
    },
    "w",
  ) as ExtensionManifest;
  assert.deepEqual(m.requires, { keyboard: true });
  assert.deepEqual(m.contributes.commands[0].requires, { width: "expanded" });
  assert.deepEqual(m.contributes.views.sidebar[0].requires, { pointer: "fine" });
  assert.equal(parseManifest({ requires: { platform: "desktop" } }, "w"), '"requires".platform isn\'t something a device has: "keyboard": true, "width": one of compact, medium, expanded, large, or "pointer": "fine"');
  assert.match(parseManifest({ requires: { width: "wide" } }, "w") as string, /"requires".width isn't something a device has/);
  assert.equal("requires" in (parseManifest({}, "w") as ExtensionManifest), false, "nothing needed, nothing said");
});

/** A device the runtime can read, whose facts a test changes. */
function fakeDevice(facts: Facts, overrides: Record<string, "on" | "off"> = {}) {
  const listeners: Array<() => void> = [];
  return {
    facts,
    override: (id: string) => overrides[id],
    has: (c: "keyboard" | "touch") => (c === "keyboard" ? facts.keyboard : facts.touch),
    atLeast: () => true,
    why: () => "",
    onChange: (fn: () => void) => (listeners.push(fn), () => {}),
    describe: () => ({ facts, why: {} }),
  };
}

async function runtimeOn(device: ReturnType<typeof fakeDevice>) {
  const { Commands } = await import("../web/src/commands.ts");
  const { ExtensionRuntime } = await import("../web/src/extension-runtime.ts");
  const notices: string[] = [];
  const promoted: string[] = [];
  const commands = new Commands((title, why) => void notices.push(`${title}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`));
  const runtime = new ExtensionRuntime({
    me: "you@example.com",
    commands,
    bar: { provide() {}, open() {} } as never,
    panels: { register() {}, toggle() {}, show() {}, shown: () => null, refresh() {} } as never,
    workbench: { registerView() {}, openView() {}, provideViews() {}, refreshView() {}, extend() {}, notice: (m: string) => void notices.push(m) } as never,
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
    device: device as never,
    promoted: (id) => void promoted.push(id),
  });
  return { runtime, commands, notices, promoted };
}

const builtIn = (id: string, module: ExtensionModule, more: Record<string, unknown>): BuiltIn => ({
  manifest: parseManifest({ name: id, ...more }, id) as ExtensionManifest,
  load: async () => module,
  files: ["index.js"],
  source: async () => "",
  copy: async () => ({}),
  folder: `web/src/extensions/${id}`,
});

test("an extension that needs a keyboard is off on a phone, and goes in as the app runs once one is found", async () => {
  const device = fakeDevice({ ...phone });
  const { runtime, commands, promoted } = await runtimeOn(device);
  const started: string[] = [];
  await runtime.load([builtIn("keys", { activate: () => void started.push("keys") }, { requires: { keyboard: true }, contributes: { commands: [{ command: "keys.help", title: "Show keys" }] } })], [], [], false, []);
  runtime.declare();
  await runtime.start();
  assert.equal(runtime.host.records[0].state, "unmet");
  assert.deepEqual(started, [], "it didn't start");
  assert.equal(commands.all().some((c) => c.id === "keys.help"), false, "what it adds isn't in effect");
  assert.deepEqual(await runtime.promote(), [], "nothing changed, nothing goes in");

  device.facts.keyboard = true;
  assert.deepEqual(await runtime.promote(), ["keys"]);
  assert.equal(runtime.host.records[0].state, "active");
  assert.deepEqual(started, ["keys"]);
  assert.deepEqual(promoted, ["keys"], "the app is told, so it needn't reload for it");
  assert.equal(commands.all().some((c) => c.id === "keys.help"), true);
});

test("turned on here, an extension runs whatever it needs; turned off here, it doesn't start", async () => {
  const { runtime } = await runtimeOn(fakeDevice({ ...phone }, { keys: "on", plain: "off" }));
  await runtime.load([builtIn("keys", { activate() {} }, { requires: { keyboard: true } }), builtIn("plain", { activate() {} }, {})], [], [], false, []);
  assert.deepEqual(
    runtime.host.records.map((r) => [r.id, r.state]),
    [
      ["keys", "inactive"],
      ["plain", "unmet"],
    ],
  );
});

test("a command that needs a wider screen is listed greyed with why, and running it says so", async () => {
  const device = fakeDevice({ ...phone });
  const { runtime, commands, notices } = await runtimeOn(device);
  let ctx!: ExtensionContext;
  const ran: string[] = [];
  await runtime.load(
    [
      builtIn(
        "windows",
        {
          activate: (c) => {
            ctx = c;
            c.commands.register("windows.beside", () => void ran.push("beside"));
          },
        },
        { contributes: { commands: [{ command: "windows.beside", title: "Open beside", requires: { width: "expanded" } }] } },
      ),
    ],
    [],
    [],
    false,
    [],
  );
  runtime.declare();
  await runtime.start();
  assert.deepEqual(
    ctx.commands.all().find((c) => c.id === "windows.beside"),
    { id: "windows.beside", title: "Open beside", off: "Off on this device · needs a screen 840px wide" },
  );
  commands.run("windows.beside");
  assert.deepEqual(notices, ["Open beside: off on this device · needs a screen 840px wide"]);
  assert.deepEqual(ran, []);
  Object.assign(device.facts, { width: "expanded", px: 900 });
  assert.equal(ctx.commands.all().find((c) => c.id === "windows.beside")!.off, undefined, "back when there's room");
  commands.run("windows.beside");
  assert.deepEqual(ran, ["beside"]);
});

test("Vim needs a keyboard, tabs 600px and windows side by side 840px; their commands say so", async () => {
  const read = (id: string) => parseManifest(JSON.parse(readFileSync(`web/src/extensions/${id}/extension.json`, "utf8")), id, { builtIn: true }) as ExtensionManifest;
  const vim = read("vim");
  const workbench = read("workbench");
  assert.deepEqual(vim.requires, { keyboard: true });
  assert.deepEqual(
    workbench.contributes.layout.map((p) => [p.id, p.requires]),
    [
      ["tabs", { width: "medium" }],
      ["splits", { width: "expanded" }],
    ],
  );
  assert.deepEqual(workbench.contributes.commands.find((c) => c.command === "window.splitRight")?.requires, { width: "expanded" });
  assert.deepEqual(workbench.contributes.commands.find((c) => c.command === "tab.next")?.requires, { width: "medium" });

  const tablet = fakeDevice({ width: "medium", px: 700, pointer: "coarse", touch: true, keyboard: false });
  const { runtime } = await runtimeOn(tablet);
  const builtIn = (m: ExtensionManifest): BuiltIn => ({ manifest: m, load: async () => ({ activate() {} }), files: [], source: async () => "", copy: async () => ({}), folder: "" });
  await runtime.load([builtIn(vim), builtIn(workbench)], [], [], false, []);
  assert.equal(runtime.host.records.find((r) => r.id === "vim")!.state, "unmet");
  assert.equal(runtime.layoutPart("tabs"), null, "tabs show on a tablet");
  assert.equal(runtime.layoutPart("splits"), "Off on this device · needs a screen 840px wide");
  assert.equal(runtime.layoutPart("panels"), undefined, "a part no extension draws");
});
