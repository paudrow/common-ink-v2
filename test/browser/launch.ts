// What the browser tests and the probe CLI start: the real Worker (wrangler's unstable_dev) on the built
// app, with a dev user and test levers, and headless Chrome (CHROME_PATH, or Chrome where it usually is).
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { unstable_dev } from "wrangler";

const root = path.resolve(import.meta.dirname, "../..");

export const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(
  (p) => p && existsSync(p),
);

export interface LocalWorker {
  base: string;
  stop(): Promise<void>;
}

/** The Worker on the built app, with nothing kept between runs. `vars` replace the dev ones: leave LEVERS out to see the app as production runs it. */
export async function startWorker(vars: Record<string, string> = { DEV_USER: "tester@localhost", SEED: "1", DATA_FIXTURES: "1", LEVERS: "1" }): Promise<LocalWorker> {
  const worker = await unstable_dev(path.join(root, "worker/src/index.ts"), {
    config: path.join(root, "worker/wrangler.jsonc"),
    vars,
    experimental: { disableExperimentalWarning: true },
    persist: false,
    logLevel: "none",
  } as never);
  return { base: `http://${worker.address}:${worker.port}`, stop: () => worker.stop() };
}

export async function launchChrome(): Promise<Browser> {
  if (!CHROME) throw new Error("Chrome is needed: set CHROME_PATH");
  // WebGL without a GPU (CI), for three.js in an html-app.
  return chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-color-profile=srgb", "--font-render-hinting=none"] });
}

/** The newest change to a file under `dir`, in ms. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) latest = Math.max(latest, statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return latest;
}

/** Build the app and its seeds if they're missing or older than the code and samples they come from. */
export function ensureBuilt(): void {
  const built = path.join(root, "dist/levers/scenarios.json");
  const stamp = existsSync(built) ? statSync(built).mtimeMs : 0;
  const sources = Math.max(...["web", "worker/src", "examples", "test/scenarios", "test/fixtures"].map((d) => newest(path.join(root, d))));
  if (stamp > sources) return;
  for (const script of ["build", "seed"]) {
    const done = spawnSync("npm", ["run", "--silent", script], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    if (done.status !== 0) throw new Error(`npm run ${script} failed`);
  }
}

/**
 * A console error that isn't one: Chrome logs every 404 a fetch gets, and the app reads files that may
 * not exist yet (settings, an extension's state), which api.read takes as an empty file.
 */
export function isExpectedConsoleError(text: string, url: string): boolean {
  return /status of 404/.test(text) && /\/api\/file\?path=/.test(url);
}
