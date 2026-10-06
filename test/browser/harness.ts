// What the browser tests share: the real Worker with test levers on and the Preview's seed, and headless
// Chrome (test/browser/launch.ts). Each file starts its own. browserTest runs one test in a fresh
// browser context: on a scenario if it names one, with the internet stubbed, failing on any error the
// page logs, and keeping a screenshot, the inspector's state and (in CI) a trace when it fails.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { ensureBuilt, isExpectedConsoleError, launchChrome, startWorker, type LocalWorker } from "./launch.ts";
import { App } from "./pages.ts";

/** Start the Worker and Chrome before this file's tests, and stop them after. `vars` replace the Worker's dev ones. */
export function harness(vars?: Record<string, string>) {
  const h = { base: "", browser: null as unknown as Browser };
  let worker: LocalWorker | undefined;
  before(async () => {
    ensureBuilt();
    // Started side by side; whichever started is stopped after, even if the other didn't.
    const [w, b] = await Promise.allSettled([startWorker(vars), launchChrome()]);
    if (w.status === "fulfilled") [worker, h.base] = [w.value, w.value.base];
    if (b.status === "fulfilled") h.browser = b.value;
    for (const r of [w, b]) if (r.status === "rejected") throw r.reason;
  });
  after(async () => {
    await h.browser?.close();
    await worker?.stop();
  });
  return h;
}

export interface BrowserTestOptions {
  /** Reset the workspace to this scenario (test/scenarios/) first. */
  scenario?: string;
  /** Levers for the page's address: { now: "2026-10-05T09:00", permissions: "allow", net: "replay" }. */
  levers?: Record<string, string>;
  /** The note to open first, by name or path. */
  open?: string;
  viewport?: { width: number; height: number };
  /** A touch screen, as a phone has: taps, and no mouse to hover. */
  touch?: boolean;
  dark?: boolean;
  /** The browser's time zone, such as "America/Chicago": the machine's otherwise. */
  timezone?: string;
  /** Browser permissions, such as clipboard-read. */
  grant?: string[];
  /** Errors the page may log without failing the test. */
  allowErrors?: RegExp[];
  /** Requests to other sites get an empty page ("stub", the default), or reach the internet ("live"). */
  internet?: "stub" | "live";
  /** Pages to serve in place of other sites' (by host, like "www.youtube-nocookie.com"), stubbed or not: a fake player, say. */
  sites?: Record<string, string>;
  /** Known to fail, and why: the pull request that fixes it. The test runs, and its failure is reported but doesn't fail the run. */
  todo?: string;
}

const RESULTS = path.resolve(import.meta.dirname, "../../test-results");
const tracing = !!(process.env.CI || process.env.TRACE);

/** One browser test, in its own context, as a person would meet the app: see BrowserTestOptions. */
export function browserTest(h: ReturnType<typeof harness>, name: string, o: BrowserTestOptions, body: (app: App) => Promise<void>) {
  test(name, o.todo ? { todo: o.todo } : {}, async (t) => {
    const context = await h.browser.newContext({ viewport: o.viewport ?? { width: 1200, height: 800 }, colorScheme: o.dark ? "dark" : "light", ...(o.touch ? { hasTouch: true, isMobile: true } : {}), ...(o.timezone ? { timezoneId: o.timezone } : {}) });
    // TypeScript run by the test runner names functions with a helper that pages passed them don't have.
    await context.addInitScript("window.__name = (f) => f");
    if (o.grant) await context.grantPermissions(o.grant, { origin: h.base });
    if ((o.internet ?? "stub") === "stub") await context.route((url) => !url.href.startsWith(h.base) && url.protocol.startsWith("http"), (route) => route.fulfill({ contentType: "text/html", body: "" }));
    for (const [host, body] of Object.entries(o.sites ?? {})) await context.route((url) => url.host === host, (route) => route.fulfill({ contentType: "text/html", body }));
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !isExpectedConsoleError(m.text(), m.location().url) && errors.push(m.text()));
    const app = new App(page, h.base);
    try {
      if (o.scenario) await app.reset(o.scenario);
      await app.goto(o.levers, o.open);
      await body(app);
      assert.deepEqual(
        errors.filter((e) => !o.allowErrors?.some((r) => r.test(e))),
        [],
        "the page logged no errors",
      );
      if (tracing) await context.tracing.stop();
      if (o.todo) t.diagnostic(`This passes now: take its todo off (${o.todo})`);
    } catch (err) {
      await keepEvidence(name, page, errors, tracing ? (file) => context.tracing.stop({ path: file }) : null);
      throw err;
    } finally {
      await context.close();
    }
  });
}

/** A failed test's screenshot, inspector state, page errors and trace, in test-results/<test>/ (CI uploads it). */
async function keepEvidence(name: string, page: Page, errors: string[], trace: ((file: string) => Promise<void>) | null) {
  const dir = path.join(RESULTS, name.replace(/[^\w]+/g, "-").slice(0, 80));
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true }).catch(() => {});
  const state = await page.evaluate(() => (window as unknown as { __commonInk?: { state(): unknown } }).__commonInk?.state()).catch((e: Error) => ({ unavailable: e.message }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state ?? { unavailable: "no inspector on the page" }, null, 2));
  fs.writeFileSync(path.join(dir, "errors.txt"), errors.join("\n"));
  await trace?.(path.join(dir, "trace.zip")).catch(() => {});
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
