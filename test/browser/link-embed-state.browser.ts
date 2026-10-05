// A link embed keeps its frame, so a playing video keeps playing: the same iframe, never reloaded,
// while the cursor comes onto its line and goes (the raw link shows above the frame, which stays),
// while the note is edited elsewhere, and while it's drawn again.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const NOTE = "# Video\n\nAbove\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\nBelow\n";
const FRAME = '.cm-url-embed[data-url-embed="youtube"] iframe';

/** Mark the video's iframe and the page in it, to tell later whether either was made again. */
async function mark(app: App) {
  await app.page.locator(FRAME).waitFor();
  await app.page.evaluate((sel) => ((window as unknown as { kept: Element }).kept = document.querySelector(sel)!), FRAME);
  const frame = await (await app.page.$(FRAME))!.contentFrame();
  await frame!.waitForLoadState();
  await frame!.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
}

/** Whether it's the same iframe with the same page in it, and whether it shows. */
async function kept(app: App) {
  const element = await app.page.evaluate((sel) => document.querySelector(sel) === (window as unknown as { kept: Element }).kept, FRAME);
  const frame = await (await app.page.$(FRAME))?.contentFrame();
  const page = (await frame?.evaluate(() => (window as unknown as { mark?: number }).mark === 1)) ?? false;
  const shown = await app.page.evaluate((sel) => {
    const box = document.querySelector(sel)!.getBoundingClientRect();
    return box.height > 50 && getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility === "visible";
  }, FRAME);
  return { element, page, shown };
}

const rawLink = (app: App) => app.page.evaluate(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));

browserTest(h, "a video's frame stays the same iframe, shown, while the cursor comes onto its line and goes, and while the note is edited elsewhere", {}, async (app) => {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await mark(app);
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>jj");
  await app.page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "on its line: the raw link shows, and the video under it plays on");
  // The frame is under the link's line, not over it.
  const [line, frame] = await app.page.evaluate((sel) => [[...document.querySelectorAll(".cm-line")].find((l) => l.textContent!.includes("youtube.com/watch"))!.getBoundingClientRect().bottom, document.querySelector(sel)!.getBoundingClientRect().top], FRAME);
  assert.ok(frame >= line - 1, `the frame (top ${frame}) is below the link's line (bottom ${line})`);
  await app.keys("jj");
  await app.page.waitForFunction(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "off its line again");
  // Edits elsewhere in the note: above it, and below it.
  await app.keys("ATyping below<Esc>ggjAAnd above<Esc>");
  await app.idle();
  assert.equal(await rawLink(app), false);
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "after edits elsewhere");
});
