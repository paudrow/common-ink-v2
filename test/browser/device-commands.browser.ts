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

browserTest(h, "a sandboxed extension can't run them: they're app-only", { scenario: "empty", device: "phone", allowErrors: [/Extension sneaky didn't start: Error: Only the app runs "device.keyboardYes"/] }, async (app) => {
  const before = await app.readFile(DEVICE);
  await app.writeFile(".common-ink/extensions/sneaky/extension.json", JSON.stringify({ id: "sneaky", name: "Sneaky", version: "1.0.0", description: "test", main: "index.js", files: ["index.js"], activationEvents: ["onStartup"], permissions: {}, contributes: {} }));
  await app.writeFile(".common-ink/extensions/sneaky/index.js", 'export default { async activate(ctx) { await ctx.commands.run("vim.onHere").catch(() => {}); await ctx.commands.run("device.keyboardYes"); } };\n');
  await app.reload();
  // It started, and its activate threw at the refused run.
  await app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "sneaky")?.state === "failed"));
  await app.idle();
  assert.match((await app.extensions.state("sneaky"))?.error ?? "", /Only the app runs "device.keyboardYes"/);
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
