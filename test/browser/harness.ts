// What the browser tests share: the real Worker (wrangler's unstable_dev) with the Preview's seed, and
// headless Chrome (CHROME_PATH, or Chrome where it usually is). Each file starts its own.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(
  (p) => p && existsSync(p),
);

/** Start the Worker and Chrome before this file's tests, and stop them after. */
export function harness() {
  const h = { base: "", browser: null as unknown as Browser };
  let worker: Unstable_DevWorker;
  before(async () => {
    assert.ok(CHROME, "Chrome is needed: set CHROME_PATH");
    worker = await unstable_dev("worker/src/index.ts", {
      config: "worker/wrangler.jsonc",
      vars: { DEV_USER: "tester@localhost", SEED: "1", DATA_FIXTURES: "1" },
      experimental: { disableExperimentalWarning: true },
      persist: false,
      logLevel: "none",
    } as never);
    h.base = `http://${worker.address}:${worker.port}`;
    // WebGL without a GPU (CI), for three.js in an html-app.
    h.browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  });
  after(async () => {
    await h.browser?.close();
    await worker?.stop();
  });
  return h;
}

/** Run a command from the command bar, by its title. */
export const runCommand = (page: Page, title: string) =>
  page.evaluate((title) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, ctrlKey: !navigator.platform.includes("Mac"), shiftKey: true, bubbles: true }));
    const input = document.querySelector<HTMLInputElement>("#command-bar input")!;
    input.value = `>${title}`;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, title);

/** Write a file as the signed-in person. */
export const writeFile = (page: Page, path: string, text: string) =>
  page.evaluate(
    async ([path, text]) => {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const base = res.status === 200 ? (await res.json()).revision : 0;
      await fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, text, base }) });
    },
    [path, text],
  );
