// Devices (worker/src/devices.ts, web/src/device.ts): what the device has decides which extensions
// are on there. On a phone, one that needs a keyboard is off, with why; it goes in as the app runs once
// a keyboard is found, or once you turn it on here; and the device's file keeps what was seen.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { App } from "./pages.ts";

const h = harness();

/** A sandboxed workspace extension that needs a keyboard, and keeps what ctx.device tells it as it starts in its state. */
async function installKeysDemo(app: App) {
  await app.writeFile(".common-ink/extensions/keys-demo/extension.json", JSON.stringify({ name: "Keys demo", version: "1.0.0", requires: { keyboard: true }, activationEvents: ["onStartup"] }));
  await app.writeFile(
    ".common-ink/extensions/keys-demo/index.js",
    `export default { activate(ctx) { return ctx.state.set({ width: ctx.device.width, keyboard: ctx.device.has("keyboard") }); } };`,
  );
  await app.reload();
  await app.idle();
}

const devicePath = (id: string) => `.common-ink/users/tester@localhost/devices/${id}/device.json`;
/** What the demo saw as it started, once it has. */
async function demoSaw(app: App) {
  await app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "keys-demo")?.state === "active"));
  await app.idle();
  return JSON.parse(await app.readFile(".common-ink/extensions/keys-demo/state.json"));
}

browserTest(h, "on a phone, an extension that needs a keyboard is off with why, and goes in once a keyboard is found", { scenario: "empty", device: "phone" }, async (app) => {
  await installKeysDemo(app);
  assert.equal((await app.extensions.state("keys-demo"))?.state, "unmet");
  await app.command("Open Extensions in a window");
  const row = app.extensions.row("keys-demo");
  await row.waitFor();
  assert.match(await row.innerText(), /Off on this device · needs a keyboard/);
  assert.match(await app.page.locator(".device-box").innerText(), /compact width \(375px\) · touch · no mouse or trackpad · keyboard: no/);

  const file = JSON.parse(await app.readFile(devicePath("lever-phone")));
  assert.deepEqual(file.seen, { width: "compact", pointer: "coarse", touch: true, keyboard: false }, "the device's file says what was seen");

  // A phone's own cursor keys alone aren't a keyboard: some on-screen keyboards send them.
  for (const k of ["ArrowLeft", "ArrowRight", "Home"]) await app.page.keyboard.press(k);
  await app.page.waitForTimeout(300);
  assert.equal(await app.page.evaluate(() => document.documentElement.hasAttribute("data-keyboard")), false, "cursor keys alone");
  // Escape as well: two kinds of key a touch screen's keyboard rarely sends.
  await app.page.keyboard.press("Escape");
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  assert.deepEqual(await demoSaw(app), { width: "compact", keyboard: true }, "in, without a reload; and ctx.device answers in the sandbox");
  assert.deepEqual((await app.state()).notices, ["Keyboard found: Vim, Keys demo are on."]);
  await app.page.waitForFunction(() => !document.querySelector('.extension-row[data-extension="keys-demo"] .extension-here'));
  await app.idle();
  assert.equal(JSON.parse(await app.readFile(devicePath("lever-phone"))).seen.keyboard, true, "kept once found");
  await app.reload();
  assert.equal((await app.extensions.state("keys-demo"))?.state, "active", "and after a reload");
});

browserTest(h, "On here runs an extension on a device that hasn't what it needs; Off here turns one off after a reload", { scenario: "empty", device: "phone" }, async (app) => {
  await installKeysDemo(app);
  await app.command("Open Extensions in a window");
  await app.extensions.row("keys-demo").locator(".extension-open").click();
  await app.page.getByLabel("Keys demo on this device").selectOption("on");
  assert.deepEqual(await demoSaw(app), { width: "compact", keyboard: false });
  assert.match(await app.page.locator(".extension-details .extension-here").innerText(), /On here · you turned it on; it needs a keyboard/);
  await app.idle();
  assert.deepEqual(JSON.parse(await app.readFile(devicePath("lever-phone"))).extensions, { "keys-demo": "on" });

  await app.page.locator(".extension-details .modal-close").click();
  await app.extensions.row("live-preview").locator(".extension-open").click();
  await app.page.getByLabel("Live preview on this device").selectOption("off");
  await app.page.locator(".extensions-view .banner", { hasText: "Extension changes apply after reload" }).waitFor();
  await app.reload();
  assert.equal((await app.extensions.state("live-preview"))?.state, "unmet");
});

browserTest(h, "on a laptop the same extension is on, and Settings › This device says why the app thinks there's a keyboard", { scenario: "empty" }, async (app) => {
  await installKeysDemo(app);
  assert.equal((await app.extensions.state("keys-demo"))?.state, "active");
  await app.command("Open user settings");
  await app.page.locator('[data-focus="level:device"]').click();
  const keyboard = app.page.locator(".device-fact", { hasText: "Keyboard" });
  assert.match(await keyboard.innerText(), /Yes\s*it has a mouse or trackpad that hovers, as a desktop does/);
  await keyboard.getByLabel("Keyboard").selectOption("no");
  await app.page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));
  assert.match(await app.page.locator(".device-fact", { hasText: "Keyboard" }).innerText(), /No\s*you said so in Settings › This device/);
  await app.idle();
  const id = await app.page.evaluate(() => localStorage.getItem("common-ink.device"));
  assert.equal(JSON.parse(await app.readFile(devicePath(id!))).keyboard, "no");
});

browserTest(h, "the device lever frames the page to a phone in a wider window", { scenario: "empty", viewport: { width: 1200, height: 800 }, levers: { device: "phone" } }, async (app) => {
  const box = await app.page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { width: r.width, height: r.height, width_class: document.documentElement.dataset.width };
  });
  assert.deepEqual(box, { width: 375, height: 800, width_class: "compact" });
});

const deviceHistory = (app: App, path: string) =>
  app.page.evaluate(async (path) => ((await (await fetch(`/api/history?${new URLSearchParams({ path, limit: "100" })}`)).json()) as unknown[]).length, path);

browserTest(h, "two tabs on one device: an override set in one survives a keyboard change in the other", { scenario: "empty" }, async (app) => {
  await installKeysDemo(app);
  const id = await app.page.evaluate(() => localStorage.getItem("common-ink.device"));
  const path = devicePath(id!);
  // Opened before the first tab changes anything, so what it has of the file is out of date.
  const app2 = new App(await app.page.context().newPage(), app.base);
  await app2.goto();
  await app2.idle();
  await app.command("Open Extensions in a window");
  await app.extensions.row("keys-demo").locator(".extension-open").click();
  await app.page.getByLabel("Keys demo on this device").selectOption("off");
  await app.idle();
  await app2.command("Open user settings");
  await app2.page.locator('[data-focus="level:device"]').click();
  await app2.page.locator(".device-fact", { hasText: "Keyboard" }).getByLabel("Keyboard").selectOption("no");
  await app2.idle();
  const file = JSON.parse(await app.readFile(path));
  assert.equal(file.keyboard, "no");
  assert.deepEqual(file.extensions, { "keys-demo": "off" }, "the second tab's write kept the first tab's override");
  // And the first tab heard of the second's change.
  await app.page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));
});

browserTest(h, "tabs at different widths don't write the device file in turns", { scenario: "empty" }, async (app) => {
  await app.idle();
  const id = await app.page.evaluate(() => localStorage.getItem("common-ink.device"));
  const path = devicePath(id!);
  const narrow = new App(await app.page.context().newPage(), app.base);
  await narrow.page.setViewportSize({ width: 500, height: 800 });
  await narrow.goto();
  await narrow.idle();
  const before = await deviceHistory(app, path);
  for (const tab of [app, narrow, app, narrow]) {
    await tab.reload();
    await tab.idle();
  }
  assert.equal(await deviceHistory(app, path), before, "no new change to device.json");
  assert.equal(JSON.parse(await app.readFile(path)).seen.width, "large", "the widest it was seen at");
});

browserTest(h, "on a touch screen, Not a keyboard? takes a found keyboard back, and what went in with it", { scenario: "empty", device: "phone" }, async (app) => {
  await installKeysDemo(app);
  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("Escape");
  const notice = app.page.locator(".notice", { hasText: "Keyboard found: Vim, Keys demo are on." });
  await notice.waitFor();
  const reloaded = app.page.waitForEvent("load");
  await notice.getByRole("button", { name: "Not a keyboard?" }).click();
  await reloaded;
  await app.ready();
  assert.equal(JSON.parse(await app.readFile(devicePath("lever-phone"))).keyboard, "no");
  assert.equal((await app.extensions.state("keys-demo"))?.state, "unmet", "off again, after the reload");
});

browserTest(h, "This device picked while user settings are still being read stays on show", { scenario: "empty" }, async (app) => {
  // Opening the settings editor draws it twice (it opens, and is refreshed), each reading the settings
  // files. The second drawing's read answers late, so it's still waiting when This device is picked.
  let reads = 0;
  await app.page.route(/\/api\/file\?path=.*users.*settings\.json/, async (route) => {
    if (route.request().method() === "GET" && ++reads === 2) await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => null);
  });
  await app.command("Open user settings");
  await app.page.locator('[data-focus="level:device"]').click();
  const keyboard = app.page.locator(".device-fact", { hasText: "Keyboard" }).getByLabel("Keyboard");
  await keyboard.waitFor();
  await app.page.waitForTimeout(2500);
  await app.page.unroute(/\/api\/file/);
  assert.equal(await keyboard.count(), 1, "the User level, read late, didn't draw over This device");
});
