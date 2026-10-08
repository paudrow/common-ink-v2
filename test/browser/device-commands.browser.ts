// Turning Vim on for a phone or tablet from the command bar: say the device has a keyboard, or turn Vim
// on here whatever it has. Both are what Settings › This device and the Extensions view's On here do.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const vim = async (app: App) => (await app.extensions.state("vim"))?.state;
const DEVICE = ".common-ink/users/tester@localhost/devices/lever-phone/device.json";
const file = async (app: App) => JSON.parse(await app.readFile(DEVICE));
const active = (app: App) => app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "vim")?.state === "active"));

browserTest(h, "on a phone, Keyboard: this device has a keyboard turns Vim on at once; its reverse offers a reload", { scenario: "empty", device: "phone" }, async (app) => {
  assert.equal(await vim(app), "unmet");
  await app.command("Keyboard: this device has a keyboard");
  await active(app);
  await app.idle();
  assert.equal((await file(app)).keyboard, "yes");
  await app.command("Keyboard: this device has no keyboard");
  await app.page.locator(".notice", { hasText: "This device has no keyboard. Vim goes after a reload." }).waitFor();
  await app.idle();
  assert.equal((await file(app)).keyboard, "no");
  await app.reload();
  assert.equal(await vim(app), "unmet");
});

browserTest(h, "on a phone, Vim: turn on for this device runs Vim with no keyboard found; turn off and Auto undo it", { scenario: "empty", device: "phone" }, async (app) => {
  await app.command("Vim: turn on for this device");
  await active(app);
  await app.idle();
  assert.deepEqual((await file(app)).extensions, { vim: "on" });
  await app.command("Vim: turn off for this device");
  await app.page.locator(".notice", { hasText: "Vim goes after a reload." }).waitFor();
  await app.idle();
  assert.deepEqual((await file(app)).extensions, { vim: "off" });
  await app.command("Vim: on here whenever this device has a keyboard");
  await app.idle();
  assert.deepEqual((await file(app)).extensions, {});
});

browserTest(h, "on a phone with Vim on here, Auto says Vim goes, and offers the reload", { scenario: "empty", device: "phone" }, async (app) => {
  await app.command("Vim: turn on for this device");
  await active(app);
  await app.page.locator(".notice", { hasText: "Vim is on here, keyboard or not." }).waitFor();
  await app.command("Vim: on here whenever this device has a keyboard");
  const notice = app.page.locator(".notice", { hasText: "Vim goes after a reload." });
  await notice.waitFor();
  assert.equal(await notice.getByRole("button", { name: "Reload" }).count(), 1);
});

browserTest(h, "with Vim turned off in settings, the notices say it stays off", { scenario: "empty", device: "phone" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "extensions.disabled": ["vim"] }));
  await app.reload();
  await app.command("Vim: turn on for this device");
  await app.page.locator(".notice", { hasText: "Vim stays off: it's turned off in your settings" }).waitFor();
  await app.command("Keyboard: this device has a keyboard");
  await app.page.locator(".notice", { hasText: "This device has a keyboard. Vim stays off" }).waitFor();
  assert.equal(await vim(app), "off");
});

browserTest(h, "a sandboxed extension can't run them: its call is refused, and it keeps running", { scenario: "empty", device: "phone" }, async (app) => {
  const before = await app.readFile(DEVICE);
  const said = app.page.waitForEvent("console", { predicate: (m) => m.text().startsWith("SNEAKY ") });
  // Its code asks for both as it starts: each call is refused, and it starts all the same.
  await sneaky(
    app,
    {},
    'export default { async activate(ctx) { const r = []; for (const id of ["vim.onHere", "device.keyboardYes"]) { try { await ctx.commands.run(id); r.push("ran"); } catch (e) { r.push(e.message); } } console.log("SNEAKY " + JSON.stringify(r)); } };\n',
  );
  assert.deepEqual(JSON.parse((await said).text().slice(7)), ["Sneaky can run only its own commands", "Sneaky can run only its own commands"]);
  await app.idle();
  assert.equal(await vim(app), "unmet");
  assert.equal(await app.readFile(DEVICE), before, "the device file is as it was");
});

browserTest(h, "the commands are in the command bar, found by what they're about", { scenario: "empty", device: "phone" }, async (app) => {
  await app.command("Show all commands");
  await app.page.locator("#command-bar input").fill(">vim");
  const titles = await app.page.locator("#command-bar li").allInnerTexts();
  for (const t of ["Vim: turn on for this device", "Vim: turn off for this device"]) assert.ok(titles.some((x) => x.startsWith(t)), `${t} in ${JSON.stringify(titles)}`);
  await app.page.locator("#command-bar input").fill(">keyboard");
  assert.ok((await app.page.locator("#command-bar li").allInnerTexts()).some((x) => x.startsWith("Keyboard: this device has a keyboard")));
});

/** A sandboxed extension with no permissions whose manifest names the device commands. */
async function sneaky(app: App, contributes: object, code = "export default { activate() {} };\n") {
  await app.writeFile(".common-ink/extensions/sneaky/extension.json", JSON.stringify({ id: "sneaky", name: "Sneaky", version: "1.0.0", description: "test", main: "index.js", files: ["index.js"], activationEvents: ["onStartup"], permissions: {}, contributes }));
  await app.writeFile(".common-ink/extensions/sneaky/index.js", code);
  await app.reload();
  await app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "sneaky")?.state === "active"));
}

browserTest(h, "a sandboxed extension's keys and status items can't run them either: they run for it, not for the app", { scenario: "empty", device: "phone" }, async (app) => {
  const before = await app.readFile(DEVICE);
  await sneaky(
    app,
    { keybindings: [{ key: "x", command: "vim.onHere" }, { key: "Mod-Shift-y", command: "device.keyboardYes" }], statusBarItems: [{ id: "s", alignment: "left", command: "vim.offHere" }] },
    'export default { activate(ctx) { ctx.statusBar.set("s", "Word count: 12"); } };\n',
  );
  const keep = (text: string) => JSON.stringify((({ keyboard, extensions }) => ({ keyboard, extensions }))(JSON.parse(text)));
  // A key on a phone is a keyboard found, which the device file says (seen); what you chose stays as it was.
  // The keyboard is found first, by a character typed outside the note and bound to nothing, and the
  // extension's keys come after, once Vim has gone in.
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.page.keyboard.press("z");
  await app.page.locator(".notice", { hasText: "Keyboard found" }).waitFor();
  await app.page.keyboard.press("x");
  await app.page.keyboard.press("ControlOrMeta+Shift+y");
  await app.page.locator(".status-item", { hasText: "Word count: 12" }).click();
  await app.idle();
  assert.equal(await app.page.locator(".notice", { hasText: "an extension asked" }).count(), 0, "nothing ran for it to refuse");
  assert.equal(keep(await app.readFile(DEVICE)), keep(before), "the device file keeps your choices: Keyboard Auto, no override");
  assert.equal(await app.extensions.state("sneaky").then((s) => s?.state), "active");
});

browserTest(h, "a sandboxed extension's Vim sequences and tab menu items for them never go in", { scenario: "lists", open: "Lists tour", device: "laptop" }, async (app) => {
  const path = ".common-ink/users/tester@localhost/devices/lever-laptop/device.json";
  await sneaky(app, { keybindings: [{ vim: "gZ", command: "vim.offHere" }], menus: { tabMenu: [{ command: "device.keyboardNo" }] } });
  await app.open("Lists tour");
  await app.idle();
  const before = await app.readFile(path);
  await app.page.locator(".tab-editor:not([hidden]) .cm-content").first().focus();
  await app.keys("<Esc>gZ");
  await app.page.locator(".group .tab").first().click({ button: "right" });
  await app.page.locator(".menu button").first().waitFor();
  assert.equal(await app.page.locator(".menu button", { hasText: "device.keyboardNo" }).count(), 0, "its menu item isn't there");
  await app.page.keyboard.press("Escape");
  await app.idle();
  assert.equal(await app.page.locator(".notice", { hasText: "an extension asked" }).count(), 0, "nothing ran for it to refuse");
  assert.equal(await vim(app), "active");
  assert.equal(await app.readFile(path), before, "the device file is as it was");
  assert.equal(await app.extensions.state("sneaky").then((s) => s?.state), "active");
});
