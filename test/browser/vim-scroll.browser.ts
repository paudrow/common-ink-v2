// Vim's scrolls: zt, z<CR>, zz, z., zb and z- put the cursor's line at the top, middle and bottom.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

/** Where the cursor's line sits in the editor's scroller: px from its top, and from its bottom. */
const cursorAt = (app: App) =>
  app.page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".tab-editor:not([hidden]) .cm-scroller")!.getBoundingClientRect();
    const c = document.querySelector<HTMLElement>(".tab-editor:not([hidden]) .cm-fat-cursor, .tab-editor:not([hidden]) .cm-cursor")!.getBoundingClientRect();
    return { top: Math.round(c.top - sc.top), bottom: Math.round(sc.bottom - c.bottom) };
  });

for (const viewport of [{ width: 1200, height: 800 }, { width: 375, height: 700 }])
  browserTest(h, `at ${viewport.width}px, z<CR>, z. and z- scroll the cursor's line to the top, middle and bottom, as zt, zz and zb do`, { scenario: "empty", viewport }, async (app) => {
    await app.writeFile("Z.md", Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n") + "\n");
    await app.goto({}, "Z");
    await app.idle();
    const after = async (keys: string) => {
      await app.keys("gg");
      await app.page.waitForTimeout(100);
      // Line 60, below the first screen.
      await app.keys("59j");
      await app.page.waitForTimeout(200);
      await app.keys(keys);
      await app.page.waitForTimeout(250);
      return cursorAt(app);
    };
    const [zt, zCR, zz, zDot, zb, zDash] = [await after("zt"), await after("z<CR>"), await after("zz"), await after("z."), await after("zb"), await after("z-")];
    assert.ok(zt.top <= 6, `zt puts the line at the top: ${zt.top}px`);
    assert.ok(zb.bottom <= 12, `zb puts it at the bottom: ${zb.bottom}px`);
    assert.ok(Math.abs(zz.top - zz.bottom) <= 40, `zz puts it in the middle: ${zz.top}px above, ${zz.bottom}px below`);
    assert.ok(Math.abs(zCR.top - zt.top) <= 6, `z<CR> at ${zCR.top}px from the top; zt at ${zt.top}px`);
    assert.ok(Math.abs(zDot.top - zz.top) <= 12, `z. at ${zDot.top}px from the top; zz at ${zz.top}px`);
    assert.ok(Math.abs(zDash.bottom - zb.bottom) <= 6, `z- at ${zDash.bottom}px from the bottom; zb at ${zb.bottom}px`);
  });
