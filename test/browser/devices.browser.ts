// Devices (worker/src/devices.ts, web/src/device.ts): what the device has decides which extensions
// are on there. On a phone, one that needs a keyboard is off, with why; it goes in as the app runs once
// a keyboard is found, or once you turn it on here; and the device's file keeps what was seen.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

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

  // A key a touch screen's keyboard doesn't send.
  await app.page.keyboard.press("Escape");
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  assert.deepEqual(await demoSaw(app), { width: "compact", keyboard: true }, "in, without a reload; and ctx.device answers in the sandbox");
  assert.deepEqual((await app.state()).notices, ["Keyboard found: Keys demo and shortcuts are on here."]);
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
