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
