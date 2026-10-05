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

/**
 * Every animation frame from navigation: whether a line shows the embed's raw markdown, the slot's
 * height, and what the box shows: "card" (waiting, a quiet card), "shown" (ready, its frame visible),
 * or "blank" (a slot with nothing in it, or a frame shown before it's ready).
 */
const COLD_SAMPLER = (raw: string, box: string) => `(() => {
  if (window.top !== window) return;
  window.coldFrames = [];
  const tick = () => {
    const lines = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent);
    const slot = document.querySelector(".cm-embed-slot");
    const el = document.querySelector(${JSON.stringify(box)});
    let state = null;
    if (slot) {
      const pending = el && (el.matches("[data-pending]") || el.querySelector("[data-pending]"));
      const frame = el && el.querySelector(".cm-embed-frame");
      const visible = el && getComputedStyle(el).visibility === "visible" && el.getBoundingClientRect().height > 10;
      state = !visible ? "blank" : pending ? "card" : frame && getComputedStyle(frame).opacity !== "1" && !frame.classList.contains("is-pending") ? "fading" : "shown";
    }
    window.coldFrames.push({ raw: lines.some((l) => l.startsWith(${JSON.stringify(raw)})), slot: slot ? slot.getBoundingClientRect().height : null, state });
    if (window.coldFrames.length < 600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

/**
 * A cold load of a note seen before (its embed's height is remembered): from navigation, no frame
 * shows the embed's raw markdown or a blank box, and the slot's height never changes after it's first
 * drawn. The cursor starts in the title, outside the embed.
 */
async function coldLoad(app: App, note: string, text: string, raw: string, box: string, ready: string) {
  await app.writeFile(`${note}.md`, text);
  await app.goto({}, note);
  await app.page.locator(ready).first().waitFor();
  await app.page.waitForFunction((b) => !document.querySelector(b)?.querySelector("[data-pending]") && !document.querySelector(b)?.matches("[data-pending]"), box);
  await app.page.waitForTimeout(800); // its height, remembered
  await app.page.addInitScript(COLD_SAMPLER(raw, box));
  await app.page.reload();
  await app.page.locator(ready).first().waitFor();
  await app.page.waitForFunction((b) => !document.querySelector(b)?.querySelector("[data-pending]") && !document.querySelector(b)?.matches("[data-pending]"), box);
  await app.page.waitForTimeout(600);
  const frames = (await app.page.evaluate(() => (window as unknown as { coldFrames: Array<{ raw: boolean; slot: number | null; state: string | null }> }).coldFrames)) as Array<{ raw: boolean; slot: number | null; state: string | null }>;
  const seen = JSON.stringify(frames.filter((f, i) => i === 0 || JSON.stringify(f) !== JSON.stringify(frames[i - 1])));
  assert.deepEqual(frames.filter((f) => f.raw), [], `no frame shows its raw markdown: ${seen}`);
  const drawn = frames.filter((f) => f.slot !== null);
  assert.ok(drawn.length > 5, `sampled it drawn: ${seen}`);
  assert.deepEqual(drawn.filter((f) => f.state === "blank"), [], `no blank frame: ${seen}`);
  assert.ok(drawn.every((f) => Math.abs(f.slot! - drawn[0].slot!) <= 1), `its slot keeps its height from the first frame: ${seen}`);
  assert.equal(drawn.at(-1)!.state, "shown");
  const shownAt = drawn.findIndex((f) => f.state === "shown");
  assert.deepEqual(drawn.slice(shownAt).filter((f) => f.state === "card"), [], `once shown, it stays shown: ${seen}`);
}

browserTest(h, "a cold load of a note with a Kanban board: a quiet card at the board's height until it has painted, then the board, with nothing moving", {}, async (app) => {
  await coldLoad(app, "Cold board", "# Cold board\n\nAbove\n\n:::kanban\n## To do\n- Card one\n- Card two\n## Done\n- Card three\n:::\n\nBelow\n", ":::kanban", '.cm-embed[data-embed="kanban"]', '.cm-embed[data-embed="kanban"] iframe');
});

browserTest(h, "a cold load of an html-app chart: no raw fence, no blank frame, no jump", {}, async (app) => {
  const chart = '<canvas id="c" width="300" height="120"></canvas><script>const g = document.getElementById("c").getContext("2d"); g.fillStyle = "#2f5fd0"; for (let i = 0; i < 10; i++) g.fillRect(i * 30, 120 - i * 11, 20, i * 11);</script>';
  await coldLoad(app, "Cold chart", `# Cold chart\n\nAbove\n\n\`\`\`html-app height=180\n${chart}\n\`\`\`\n\nBelow\n`, "```html-app", '.cm-embed[data-embed="html-app"]', '.cm-embed[data-embed="html-app"] iframe');
});

browserTest(h, "a cold load of a link embed: no raw link, no blank frame, no jump", {}, async (app) => {
  await coldLoad(app, "Cold link", "# Cold link\n\nAbove\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\nBelow\n", "https://www.youtube.com", ".cm-url-embed", ".cm-url-embed iframe");
});
