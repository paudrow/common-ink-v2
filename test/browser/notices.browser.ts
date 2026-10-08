// A window's notice: the note makes room for it without its text moving on screen, and closing it
// gives focus back to where it was.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
// A wider screen's layout, where a notice sits at the top of its window.
const MEDIUM = { width: 700, height: 800 };

/**
 * A sandboxed extension, Sneaky, with a command that shows news with nothing to do ("Say hello") and one
 * that asks for a permission it didn't declare, which the app refuses with an alert ("Peek").
 */
async function sneaky(app: App) {
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
      contributes: { commands: [{ command: "sneaky.say", title: "Say hello" }, { command: "sneaky.peek", title: "Peek at the clipboard" }] },
    }),
  );
  await app.writeFile(".common-ink/extensions/sneaky/index.js", 'export default { activate(ctx) { ctx.commands.register("sneaky.say", () => ctx.workbench.notice("hello")); ctx.commands.register("sneaky.peek", () => ctx.clipboard.read().catch(() => {})); } };\n');
  await app.reload();
  await active(app, "sneaky");
}

/** Where on screen a line of the note on show is, by its text. */
const lineY = (app: App, text: string) =>
  app.page.evaluate((t) => {
    const line = [...document.querySelectorAll(".tab-editor:not([hidden]) .cm-line")].find((l) => l.textContent === t);
    return line ? Math.round(line.getBoundingClientRect().top) : null;
  }, text);

for (const [where, line, keys] of [["top", 3, ["gg2j"]], ["middle", 150, ["150G", "zz"]], ["bottom", 300, ["G"]]] as const)
  browserTest(h, `a notice coming and going at the ${where} of a long note moves none of its text on screen`, { scenario: "empty", viewport: MEDIUM }, async (app) => {
    await app.writeFile("Long.md", Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n") + "\n");
    await sneaky(app);
    await app.goto({}, "Long");
    await app.idle();
    for (const k of keys) {
      await app.keys(k);
      await app.page.waitForTimeout(300);
    }
    const reference = `Line ${line === 3 ? 10 : line - 4}`;
    const before = [await lineY(app, `Line ${line}`), await lineY(app, reference)];
    assert.ok(before.every((y) => y !== null), `both lines on screen: ${before}`);
    await app.command("Say hello");
    const notice = app.page.locator(".notice", { hasText: "hello" });
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
  await sneaky(app);
  await app.goto({}, "Note");
  await app.idle();
  const editor = "div.cm-content.cm-lineWrapping";
  await app.command("Say hello");
  await app.page.locator(".notice .notice-close").click();
  assert.equal((await app.state()).focus.element, editor, "after a click");
  await app.command("Say hello");
  await app.page.locator(".notice .notice-close").focus();
  await app.page.keyboard.press("Enter");
  assert.equal((await app.state()).focus.element, editor, "after Enter");
  await app.keys("jj");
  assert.equal((await app.state()).cursor?.line, 3, "and j moves the cursor");
});

const notices = async (app: App) => (await app.state()).notices;
const active = (app: App, id: string) =>
  app.page.waitForFunction((id) => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === id)?.state === "active"), id);

for (const viewport of [{ width: 375, height: 812 }, MEDIUM])
  browserTest(h, `${viewport.width}px wide, a refusal isn't replaced by news that comes a moment later: the news shows once the refusal is closed`, { scenario: "empty", viewport, allowErrors: [/./] }, async (app) => {
    await app.writeFile("Note.md", "# Note\nalpha\n");
    await sneaky(app);
    await app.goto({}, "Note");
    await app.idle();
    await app.command("Peek at the clipboard");
    const refusal = app.page.locator(".notice", { hasText: "clipboard" });
    await refusal.waitFor();
    await app.command("Say hello");
    await app.idle();
    assert.equal((await notices(app)).length, 1);
    assert.match((await notices(app))[0], /clipboard/);
    await refusal.locator(".notice-close").click();
    await app.page.locator(".notice", { hasText: "Sneaky: hello" }).waitFor();
    assert.deepEqual(await notices(app), ["Sneaky: hello"]);
  });
