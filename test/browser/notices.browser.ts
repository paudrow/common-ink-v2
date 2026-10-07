// A window's notice: the note makes room for it without its text moving on screen, and closing it
// gives focus back to where it was.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
// Medium width: a wider screen's layout, where splitting is off ("needs a screen 840px wide"), so asking
// for a split shows a notice with nothing to do.
const MEDIUM = { width: 700, height: 800 };

/** Where on screen a line of the note on show is, by its text. */
const lineY = (app: App, text: string) =>
  app.page.evaluate((t) => {
    const line = [...document.querySelectorAll(".tab-editor:not([hidden]) .cm-line")].find((l) => l.textContent === t);
    return line ? Math.round(line.getBoundingClientRect().top) : null;
  }, text);

for (const [where, line, keys] of [["top", 3, ["gg2j"]], ["middle", 150, ["150G", "zz"]], ["bottom", 300, ["G"]]] as const)
  browserTest(h, `a notice coming and going at the ${where} of a long note moves none of its text on screen`, { scenario: "empty", viewport: MEDIUM }, async (app) => {
    await app.writeFile("Long.md", Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n") + "\n");
    await app.goto({}, "Long");
    await app.idle();
    for (const k of keys) {
      await app.keys(k);
      await app.page.waitForTimeout(300);
    }
    const reference = `Line ${line === 3 ? 10 : line - 4}`;
    const before = [await lineY(app, `Line ${line}`), await lineY(app, reference)];
    assert.ok(before.every((y) => y !== null), `both lines on screen: ${before}`);
    await app.command("Split down");
    const notice = app.page.locator(".notice", { hasText: "needs a screen 840px wide" });
    await notice.waitFor();
    await app.page.waitForTimeout(200);
    const shown = [await lineY(app, `Line ${line}`), await lineY(app, reference)];
    await notice.locator(".notice-close").click();
    await app.page.waitForTimeout(200);
    const gone = [await lineY(app, `Line ${line}`), await lineY(app, reference)];
    for (const [i, y] of [...shown, ...gone].entries()) assert.ok(Math.abs(y! - before[i % 2]!) <= 2, `line ${i % 2 ? reference : `Line ${line}`} at ${y}, was ${before[i % 2]} (shown ${shown}, gone ${gone})`);
  });

browserTest(h, "closing a notice, by click or by Enter on its ×, gives focus back to the note, so Vim's keys keep working", { scenario: "empty", viewport: MEDIUM }, async (app) => {
  await app.writeFile("Note.md", "# Note\nalpha\nbeta\n");
  await app.goto({}, "Note");
  await app.idle();
  const editor = "div.cm-content.cm-lineWrapping";
  await app.command("Split down");
  await app.page.locator(".notice .notice-close").click();
  assert.equal((await app.state()).focus.element, editor, "after a click");
  await app.command("Split down");
  await app.page.locator(".notice .notice-close").focus();
  await app.page.keyboard.press("Enter");
  assert.equal((await app.state()).focus.element, editor, "after Enter");
  await app.keys("jj");
  assert.equal((await app.state()).cursor?.line, 3, "and j moves the cursor");
});

const notices = async (app: App) => (await app.state()).notices;
const active = (app: App, id: string) =>
  app.page.waitForFunction((id) => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === id)?.state === "active"), id);

for (const device of ["phone", "tablet"] as const)
  browserTest(h, `on a ${device}, a refusal isn't replaced by news that comes a moment later: the news shows once the refusal is closed`, { scenario: "empty", device }, async (app) => {
    await app.writeFile("Note.md", "# Note\nalpha\n");
    await app.goto({}, "Note");
    await app.idle();
    await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // A chord on a touch screen is a keyboard found, said a moment after the split it asks for is refused (the screen's too narrow).
    await app.page.keyboard.press("ControlOrMeta+Backslash");
    const refusal = app.page.locator(".notice", { hasText: "Split right" });
    await refusal.waitFor();
    await active(app, "vim");
    await app.idle();
    assert.deepEqual(await notices(app), ["Split right: off on this device · needs a screen 840px wide"]);
    await refusal.locator(".notice-close").click();
    await app.page.locator(".notice", { hasText: "Keyboard found" }).waitFor();
    assert.equal((await notices(app)).length, 1);
  });

browserTest(h, "refusals in a row from one extension are summed up in one notice, not lost", { scenario: "empty", viewport: MEDIUM }, async (app) => {
  const wide = { width: "expanded" };
  await app.writeFile(
    ".common-ink/extensions/sneaky/extension.json",
    JSON.stringify({
      id: "sneaky",
      name: "Sneaky",
      version: "1.0.0",
      description: "test",
      main: "index.js",
      files: ["index.js"],
      activationEvents: ["onStartup"],
      permissions: {},
      contributes: {
        commands: [
          { command: "sneaky.left", title: "Look left", requires: wide },
          { command: "sneaky.right", title: "Look right", requires: wide },
        ],
        keybindings: [
          { key: "Mod-Alt-j", command: "sneaky.left" },
          { key: "Mod-Alt-k", command: "sneaky.right" },
        ],
      },
    }),
  );
  await app.writeFile(".common-ink/extensions/sneaky/index.js", 'export default { activate(ctx) { ctx.commands.register("sneaky.left", () => {}); ctx.commands.register("sneaky.right", () => {}); } };\n');
  await app.reload();
  await active(app, "sneaky");
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.page.keyboard.press("ControlOrMeta+Alt+j");
  await app.page.locator(".notice", { hasText: "Look left" }).waitFor();
  await app.page.keyboard.press("ControlOrMeta+Alt+k");
  await app.page.keyboard.press("ControlOrMeta+Alt+j");
  await app.page.locator(".notice", { hasText: "3 requests from Sneaky" }).waitFor();
  assert.deepEqual(await notices(app), ["3 requests from Sneaky refused: Look left and Look right (off on this device · needs a screen 840px wide)"]);
});
