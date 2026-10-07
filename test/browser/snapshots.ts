// Visual snapshots: a screenshot compared with a kept one, pixel by pixel, with a tolerance. Fonts draw
// differently on each platform, so baselines are per platform, in test/browser/snapshots/<platform>/.
// Linux's are kept in the repository, for CI; others are written on a machine's first run and kept
// there. A missing baseline fails in CI, and the one CI made is in its artifact, to commit. To take
// new ones on purpose: UPDATE_SNAPSHOTS=1 npm run test:browser.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { bounded } from "./pages.ts";

const DIR = path.join(import.meta.dirname, "snapshots", process.platform);
const RESULTS = path.resolve(import.meta.dirname, "../../test-results/snapshots", process.platform);

export interface SnapshotOptions {
  /** How much one channel of a pixel may differ (0–255) before the pixel counts as changed. */
  threshold?: number;
  /** The share of pixels that may change. */
  maxDiff?: number;
}

/**
 * Compare the page with its baseline `name`, or write the baseline if there isn't one (outside CI).
 * Answers what's wrong, or null, so a test takes all its pictures before it fails.
 */
export async function matchSnapshot(page: Page, name: string, { threshold = 32, maxDiff = 0.002 }: SnapshotOptions = {}): Promise<string | null> {
  // The editor's own cursor and the focused line move with every keypress; neither is what's checked.
  await page.addStyleTag({ content: ".cm-cursorLayer, .cm-selectionLayer { visibility: hidden !important; }" });
  await bounded("document.fonts.ready", page.evaluate(() => document.fonts.ready));
  // The Feed beside the note lists notes newest change first, and opening a note can change one: which
  // card comes where isn't what these pictures check, so the Feed's column is covered.
  const shot = await page.screenshot({ animations: "disabled", caret: "hide", mask: [page.locator(".list-feed:not([hidden])")] });
  const baseline = path.join(DIR, `${name}.png`);
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(baseline)) {
    if (process.env.CI && !process.env.UPDATE_SNAPSHOTS) {
      write(path.join(RESULTS, `${name}.png`), shot);
      return `No ${process.platform} baseline for the ${name} snapshot: CI's is in its test-results artifact, as snapshots/${process.platform}/${name}.png; commit it to test/browser/snapshots/${process.platform}/`;
    }
    write(baseline, shot);
    return null;
  }
  const { ratio, diff, size } = await compare(page, shot, fs.readFileSync(baseline), threshold);
  if (ratio <= maxDiff) return null;
  write(path.join(RESULTS, `${name}.png`), shot);
  if (diff) write(path.join(RESULTS, `${name}-diff.png`), Buffer.from(diff, "base64"));
  return `The ${name} snapshot changed: ${size ?? `${(ratio * 100).toFixed(2)}% of pixels`} (allowed ${(maxDiff * 100).toFixed(2)}%). This run's and the difference are in test-results/snapshots/; UPDATE_SNAPSHOTS=1 takes it as the new baseline.`;
}

function write(file: string, data: Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** The share of pixels that differ by more than `threshold` in any channel, and an image of where, worked out in a blank page. */
async function compare(page: Page, a: Buffer, b: Buffer, threshold: number): Promise<{ ratio: number; diff?: string; size?: string }> {
  const blank = await page.context().newPage();
  try {
    return (await bounded("a snapshot's comparison", blank.evaluate(
      `(async ([a, b, threshold]) => {
        const load = async (data) => { const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode(); return img; };
        const [x, y] = await Promise.all([load(a), load(b)]);
        if (x.width !== y.width || x.height !== y.height) return { ratio: 1, size: x.width + "×" + x.height + " now, " + y.width + "×" + y.height + " before" };
        const c = document.createElement("canvas");
        c.width = x.width;
        c.height = x.height;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(x, 0, 0);
        const p = g.getImageData(0, 0, c.width, c.height).data;
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(y, 0, 0);
        const q = g.getImageData(0, 0, c.width, c.height).data;
        const out = g.createImageData(c.width, c.height);
        let changed = 0;
        for (let i = 0; i < p.length; i += 4) {
          const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]), Math.abs(p[i + 3] - q[i + 3]));
          if (d > threshold) { changed++; out.data.set([255, 0, 0, 255], i); } else out.data.set([p[i], p[i + 1], p[i + 2], 40], i);
        }
        g.putImageData(out, 0, 0);
        return { ratio: changed / (c.width * c.height), diff: c.toDataURL().split(",")[1] };
      })(${JSON.stringify([a.toString("base64"), b.toString("base64"), threshold])})`,
    ))) as { ratio: number; diff?: string; size?: string };
  } finally {
    await blank.close();
  }
}
