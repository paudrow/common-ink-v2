// What Vim and the Workbench need from the device: Vim a keyboard, tabs 600px and windows side by side
// 840px. What doesn't fit is put away and kept, never closed, and each device keeps its own layout.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { App } from "./pages.ts";
import { PRESETS } from "../../web/src/device.ts";

const h = harness();

const shown = (app: App) => app.page.evaluate(() => [...document.querySelectorAll("#workbench section.group")].filter((g) => g.getClientRects().length).length);
const tabBarShown = (app: App) => app.page.evaluate(() => !!document.querySelector("#workbench section.group.focused .tabs")?.getClientRects().length);
const layoutChanges = async (app: App) => (await app.state()).history.filter((c) => c.path.endsWith("layout.json")).length;

browserTest(h, "windows that don't fit the width are put away and kept, and come back when there's room", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.command("Split right");
  await app.page.waitForFunction(() => document.querySelectorAll("#workbench section.group").length === 2);
  await app.idle();
  await app.page.waitForTimeout(1700);
  const before = await layoutChanges(app);

  await app.page.setViewportSize({ width: 700, height: 800 });
  await app.page.waitForFunction(() => document.querySelector("#workbench")!.hasAttribute("data-no-splits"));
  assert.equal(await shown(app), 1, "medium: one window shows");
  assert.equal(await tabBarShown(app), true, "medium: its tabs do");
  const state = await app.state();
  assert.equal(state.windows.length, 2, "the other is kept in the layout");
  assert.deepEqual(
    state.windows.map((w) => (w as unknown as { suspended: boolean }).suspended),
    [true, false],
  );
  assert.deepEqual(await app.call("check.layoutFill"), [], "the one that shows fills the area");

  await app.page.setViewportSize({ width: 500, height: 800 });
  await app.page.waitForFunction(() => document.querySelector("#workbench")!.hasAttribute("data-no-tabs"));
  assert.equal(await tabBarShown(app), false, "compact: no tabs");
  await app.command("Split right");
  assert.deepEqual((await app.state()).notices, ["Split right: off on this device · needs a screen 840px wide"]);

  await app.page.setViewportSize({ width: 1200, height: 800 });
  await app.page.waitForFunction(() => !document.querySelector("#workbench")!.hasAttribute("data-no-splits"));
  assert.equal(await shown(app), 2, "back, side by side");
  assert.deepEqual(await app.call("check.layoutFill"), []);
  await app.page.waitForTimeout(1700);
  await app.idle();
  assert.equal(await layoutChanges(app), before, "the width changing never wrote the layout");
});

browserTest(h, "layout is per device: a new wide device starts from the last wide layout, and a phone from just what was on show", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.command("Split right");
  await app.page.waitForFunction(() => document.querySelectorAll("#workbench section.group").length === 2);
  await app.page.waitForTimeout(1700);
  await app.idle();
  const first = (await app.state()) as unknown as { device: { layoutPath?: string; id: string } };
  const mine = `.common-ink/users/tester@localhost/devices/${first.device.id}/layout.json`;
  assert.equal(JSON.parse(await app.readFile(mine)).root.kind, "split", "the layout is this device's");
  assert.equal(JSON.parse(await app.readFile(".common-ink/layout.json")).root.kind, "group", "not the workspace's");

  const open = async (device?: "phone") => {
    const preset = device && PRESETS[device];
    const context = await h.browser.newContext({ viewport: preset ? { width: preset.width, height: preset.height } : { width: 1200, height: 800 }, hasTouch: !!preset, isMobile: !!preset });
    await context.addInitScript("window.__name = (f) => f");
    const other = new App(await context.newPage(), h.base);
    await other.goto(device ? { device } : {});
    await other.idle();
    return { other, context };
  };
  const laptop = await open();
  assert.equal(L(await laptop.other.state()).groups, 2, "another laptop starts from it");
  await laptop.context.close();

  const phone = await open("phone");
  const s = L(await phone.other.state(), ["feed"]);
  // And the Feed it opens on (decision 21), beside it.
  assert.deepEqual([s.groups, s.tabs], [1, 1], "a phone keeps only the window and tab on show");
  await phone.context.close();
});

/** How many windows and tabs a layout has, leaving out tabs of the views named. */
function L(state: { layout: unknown }, leaveOut: string[] = []) {
  type N = { kind: "group"; tabs: Array<{ view?: string }> } | { kind: "split"; children: N[] };
  const groups: Array<{ tabs: Array<{ view?: string }> }> = [];
  const walk = (n: N) => (n.kind === "group" ? groups.push(n) : n.children.forEach(walk));
  walk((state.layout as { root: N }).root);
  return { groups: groups.length, tabs: groups.reduce((t, g) => t + g.tabs.filter((tab) => !leaveOut.includes(tab.view ?? "")).length, 0) };
}

browserTest(h, "on a phone Vim is off and keys aren't hinted until a keyboard is found; then both are, without a reload", { scenario: "empty", device: "phone" }, async (app) => {
  assert.equal((await app.extensions.state("vim"))?.state, "unmet");
  /** What the command list says beside "Search…" (⌘K): its shortcut, if keys are hinted. */
  const hint = async () => {
    await app.command("Show all commands");
    // Filled in, not typed: typed keys would be a keyboard.
    await app.page.locator("#command-bar input").fill(">Search");
    const item = app.page.locator("#command-bar li", { hasText: "Search…" }).first();
    await item.waitFor();
    return (await item.locator(".detail").count()) ? await item.locator(".detail").innerText() : "";
  };
  assert.equal(await hint(), "", "no shortcut without a keyboard");
  // An arrow and then Escape, which closes the bar: two kinds of key a touch screen's keyboard rarely sends.
  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("Escape");
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  await app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "vim")?.state === "active"));
  assert.match(await hint(), /^(⌘K|Ctrl\+K)$/, "hinted now");
});
