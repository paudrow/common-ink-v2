// Embeds drawn in a frame keep it while the cursor shows their markdown: the same iframe, never
// reloaded, shown again with no blank frame and nothing below it moving.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const NOTE = "# Keep\n\nAbove\n\n:::kanban\n## To do\n- Card\n:::\n\nBelow\n";

/** Mark the kanban's iframe element and its page, to tell later whether either was made again. */
async function mark(app: App) {
  await app.page.locator('.cm-embed[data-embed="kanban"] iframe').waitFor();
  await app.page.frameLocator('.cm-embed[data-embed="kanban"] iframe').locator(".card").first().waitFor();
  await app.page.evaluate(() => ((window as unknown as { kept: Element }).kept = document.querySelector('.cm-embed[data-embed="kanban"] iframe')!));
  const frame = await (await app.page.$('.cm-embed[data-embed="kanban"] iframe'))!.contentFrame();
  await frame!.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
}

/** Whether it's the same iframe, with the same page in it. */
async function same(app: App) {
  const element = await app.page.evaluate(() => document.querySelector('.cm-embed[data-embed="kanban"] iframe') === (window as unknown as { kept: Element }).kept);
  const frame = await (await app.page.$('.cm-embed[data-embed="kanban"] iframe'))?.contentFrame();
  const page = (await frame?.evaluate(() => (window as unknown as { mark?: number }).mark === 1)) ?? false;
  return { element, page };
}

/** Where the line below the board is, once it's held still for a moment (the board has sized itself). */
async function settledBelow(app: App): Promise<number> {
  let last = -1;
  for (let same = 0; same < 3; ) {
    await app.page.waitForTimeout(150);
    const top = await app.page.evaluate(() => Math.round([...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Below")!.getBoundingClientRect().top));
    same = top === last ? same + 1 : 0;
    last = top;
  }
  return last;
}

/** Sample every animation frame: whether the board shows, and where the line below it is. */
const SAMPLE = `(() => {
  const samples = [];
  const tick = () => { try { step(); } catch (e) { samples.push({ error: String(e) }); } if (!window.stopSampling) requestAnimationFrame(tick); };
  const step = () => {
    const frame = document.querySelector('.cm-embed[data-embed="kanban"] iframe');
    const box = frame && frame.getBoundingClientRect();
    const raw = [...document.querySelectorAll(".cm-line")].some((l) => l.textContent === ":::kanban");
    const below = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Below");
    const shown = !!box && box.height > 20 && getComputedStyle(frame.closest(".cm-embed")).visibility === "visible";
    samples.push({ raw, shown, below: below ? Math.round(below.getBoundingClientRect().top) : null });
  };
  window.samples = samples;
  window.stopSampling = false;
  // Resolves once the first frame is sampled, so the keys come after it.
  return new Promise((started) => requestAnimationFrame(() => (tick(), started(true))));
})()`;

browserTest(h, "a Kanban board keeps its frame while the cursor is in its markdown, and shows it again with no blank frame or jump", {}, async (app) => {
  await app.writeFile("Keep.md", NOTE);
  await app.goto({}, "Keep");
  await mark(app);
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>");
  const belowBefore = await settledBelow(app);
  // Into its markdown: the raw lines show, the board doesn't.
  await app.keys("jj");
  await app.page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent === ":::kanban"));
  assert.deepEqual(await same(app), { element: true, page: true }, "kept while its markdown shows");
  // Out again, sampling every frame.
  await app.page.evaluate(SAMPLE);
  await app.keys("kk");
  await app.page.waitForFunction(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent === ":::kanban"));
  // At least a dozen frames after it, however slow the machine is.
  await app.page.waitForFunction(() => (window as unknown as { samples: unknown[] }).samples.length > 12);
  const samples = (await app.page.evaluate(() => ((window as unknown as { stopSampling: boolean }).stopSampling = true, (window as unknown as { samples: Array<{ raw: boolean; shown: boolean; below: number | null }> }).samples))) as Array<{ raw: boolean; shown: boolean; below: number | null }>;
  const after = samples.slice(samples.findIndex((s) => !s.raw));
  assert.ok(samples[0].raw && after.length > 3, `sampled from before it went back to after: ${JSON.stringify(samples)}`);
  const seen = JSON.stringify(samples);
  assert.deepEqual(after.filter((s) => !s.shown), [], `no frame without the board: ${seen}`);
  assert.deepEqual([...new Set(after.map((s) => s.below))], [belowBefore], `the line below is where it was: ${seen}`);
  assert.deepEqual(await same(app), { element: true, page: true }, "the same iframe, never reloaded");
});
