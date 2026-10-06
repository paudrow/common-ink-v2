// Turning Vim on for a phone or tablet from the command bar: say the device has a keyboard, or turn Vim
// on here whatever it has. Both are what Settings › This device and the Extensions view's On here do.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const vim = async (app: App) => (await app.extensions.state("vim"))?.state;
const file = async (app: App) => JSON.parse(await app.readFile(".common-ink/users/tester@localhost/devices/lever-phone/device.json"));
const active = (app: App) => app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "vim")?.state === "active"));

browserTest(h, "on a phone, Keyboard: this device has a keyboard turns Vim on at once; its reverse offers a reload", { scenario: "empty", device: "phone" }, async (app) => {
  assert.equal(await vim(app), "unmet");
  await app.command("Keyboard: this device has a keyboard");
  await active(app);
  await app.idle();
  assert.equal((await file(app)).keyboard, "yes");
  await app.command("Keyboard: this device has no keyboard");
  await app.page.locator(".notice", { hasText: "What needs a keyboard (Vim) goes after a reload." }).waitFor();
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

browserTest(h, "the commands are in the command bar, found by what they're about", { scenario: "empty", device: "phone" }, async (app) => {
  await app.command("Show all commands");
  await app.page.locator("#command-bar input").fill(">vim");
  const titles = await app.page.locator("#command-bar li").allInnerTexts();
  for (const t of ["Vim: turn on for this device", "Vim: turn off for this device"]) assert.ok(titles.some((x) => x.startsWith(t)), `${t} in ${JSON.stringify(titles)}`);
  await app.page.locator("#command-bar input").fill(">keyboard");
  assert.ok((await app.page.locator("#command-bar li").allInnerTexts()).some((x) => x.startsWith("Keyboard: this device has a keyboard")));
});
