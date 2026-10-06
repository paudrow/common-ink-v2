// Search, in a real browser against the real Worker: ⌘K finds notes by their words and tasks and events
// in their own sections, Tab completes filters, and on a phone it fills the screen, with chips that write
// filters into the query.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness, runCommand, writeFile } from "./harness.ts";

const h = harness();

const bar = (page: Page) => page.locator("#command-bar");
const field = (page: Page) => page.locator("#command-bar input");
/** The rows on show once the query's answers are in, section headings in capitals. */
async function rows(page: Page): Promise<string[]> {
  await page.locator("#command-bar ul:not([aria-busy])").waitFor({ state: "attached" });
  return page.locator("#command-bar li").evaluateAll((lis) => lis.map((li) => (li.classList.contains("section") ? li.textContent!.toUpperCase() : li.querySelector(".label")!.textContent!)));
}
const title = (page: Page, note: string) => page.waitForFunction((note) => document.title === `${note} · Common Ink`, note);

browserTest(h, "⌘K finds notes by their words, then tasks and events, and Tab completes a filter", { scenario: "preview", open: "Welcome" }, async ({ page }) => {
  await title(page, "Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await bar(page).waitFor();
  assert.equal((await rows(page))[0], "RECENT", "with nothing typed, the notes changed last");
  await field(page).pressSequentially("pay rent");
  const found = await rows(page);
  assert.equal(found[0], "NOTES");
  assert.ok(found.indexOf("Chores") < found.indexOf("TASKS") && found.indexOf("TASKS") < found.indexOf("Pay rent"), `the note, then the task: ${found.join(" | ")}`);

  await field(page).fill("garden fr");
  await page.keyboard.press("Tab");
  await page.keyboard.press("a");
  await page.keyboard.press("Tab");
  assert.equal(await field(page).inputValue(), "garden from:agent");
  assert.equal((await rows(page))[1], "Garden plan 2026", "the seed's notes are an agent's");
  await page.keyboard.press("Enter");
  await title(page, "Garden plan");
  assert.equal(await bar(page).isHidden(), true);
});

browserTest(h, "search follows notes as they're written, and says who wrote them", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.call("idle");
  await page.evaluate(() => fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "Zoo/Zebra facts.md", text: "# Zebra facts\nStripes, mostly.", base: 0 }) }));
  await page.keyboard.press("ControlOrMeta+k");
  await field(page).fill("stripe from:me in:zoo");
  assert.deepEqual(await rows(page), ["NOTES", "Zebra facts"]);
  await field(page).fill("stripe from:agent");
  assert.deepEqual(await rows(page), []);
});

browserTest(h, "on a phone, search fills the screen, and a chip writes its filter into the query", { scenario: "preview", open: "Welcome", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await title(page, "Welcome");
  await app.call("command", "Search…");
  await bar(page).waitFor();
  const box = await bar(page).boundingBox();
  assert.deepEqual(box && [box.x, box.y, box.width, box.height], [0, 0, 375, 812], "the whole screen");
  await field(page).fill("pay");
  assert.ok((await rows(page)).includes("EVENTS"));
  await page.locator("#command-bar .chips button", { hasText: "Tasks" }).tap();
  assert.equal(await field(page).inputValue(), "pay type:task ");
  assert.deepEqual(await rows(page), ["TASKS", "Pay rent"]);
  assert.equal(await page.locator("#command-bar .chips button", { hasText: "Tasks" }).getAttribute("aria-pressed"), "true");
  await page.locator("#command-bar li", { hasText: "Pay rent" }).tap();
  await title(page, "Chores");
  assert.equal(await bar(page).isHidden(), true);

  await app.call("command", "Search…");
  await page.locator("#command-bar .cancel").tap();
  assert.equal(await bar(page).isHidden(), true, "Cancel closes it");
});

async function install(page: Page, id: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) await writeFile(page, `.common-ink/extensions/${id}/${file}`, text);
}
const notice = (page: Page, mark: string) =>
  page.waitForFunction((mark) => [...document.querySelectorAll(".notice p")].map((p) => p.textContent).find((t) => t?.includes(mark)), mark, { timeout: 15000 }).then((h) => h.jsonValue() as Promise<string>);

const SNOOP = `export default { activate(ctx) {
  ctx.commands.register("snoop.run", async () => {
    const out = {};
    for (const q of ["garden", "pay", "type:event pay"]) out[q] = await ctx.search.find(q, 20);
    let read = "blocked"; try { await ctx.files.read("Welcome.md"); read = "reached"; } catch {}
    let events = "blocked"; try { await ctx.data.calendar.events(new Date(0), new Date(4e12)); events = "reached"; } catch {}
    await ctx.workbench.notice("SNOOP " + JSON.stringify({ read, events, out }));
  });
} };`;

browserTest(h, "a sandboxed extension with no permissions can't read notes, tasks or events through ctx.search.find", { scenario: "preview", open: "Welcome", levers: { permissions: "deny" } }, async ({ page }) => {
  await install(page, "snoop", {
    "extension.json": JSON.stringify({ name: "Snoop", activationEvents: ["onCommand:snoop.run"], contributes: { commands: [{ command: "snoop.run", title: "Run snoop" }] } }),
    "index.js": SNOOP,
  });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await runCommand(page, "Run snoop");
  const said = await notice(page, "SNOOP");
  const got = JSON.parse(said.slice(said.indexOf("{")));
  assert.equal(got.read, "blocked", "files.read is refused");
  assert.equal(got.events, "blocked", "calendar events are refused");
  const leaked = Object.values(got.out as Record<string, Array<{ results: unknown[] }>>).flat().flatMap((s) => s.results);
  assert.deepEqual(leaked, [], "search.find must not hand it what files.read and data.calendar refuse");
});

const ORACLE = `export default { activate(ctx) {
  ctx.commands.register("oracle.run", async () => {
    const ask = async (q, n) => (await ctx.search.find(q, n)).flatMap((s) => s.results.map((r) => r.path || r.title));
    const out = {};
    for (const [q, n] of [["zebra", 1], ["zebra", 20], ["zebra sort:title", 1], ["zebra sort:title", 20], ["-giraffe sort:title", 1], ["-giraffe sort:title", 20]]) out[q + " @" + n] = await ask(q, n);
    await ctx.workbench.notice("ORACLE " + JSON.stringify(out));
  });
} };`;

browserTest(h, "a sandboxed extension that may read only Public/ can't tell from the limit whether other notes match", { scenario: "empty", levers: { permissions: "deny" } }, async ({ page }) => {
  await writeFile(page, "Public/Decoy.md", "# Decoy\nzebra stripes\n");
  await writeFile(page, "Secret/Plan.md", "# Zebra acquisition\nconfidential\n");
  await writeFile(page, ".common-ink/settings.json", JSON.stringify({ "extensions.permissions": { oracle: { "files:read:Public/**": "allow" } } }));
  await install(page, "oracle", {
    "extension.json": JSON.stringify({ name: "Oracle", activationEvents: ["onCommand:oracle.run"], permissions: { "files:read": { paths: ["Public/**"], why: "read public notes" } }, contributes: { commands: [{ command: "oracle.run", title: "Run oracle" }] } }),
    "index.js": ORACLE,
  });
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __commonInk?: unknown }).__commonInk);
  await runCommand(page, "Run oracle");
  const said = await notice(page, "ORACLE");
  const got = JSON.parse(said.slice(said.indexOf("{"))) as Record<string, string[]>;
  for (const q of ["zebra", "zebra sort:title", "-giraffe sort:title"]) {
    assert.deepEqual(got[`${q} @1`], got[`${q} @20`].slice(0, 1), q);
    assert.deepEqual(got[`${q} @20`], ["Public/Decoy.md"], q);
  }
});

const SLOW = `export default { activate(ctx) {
  ctx.search.provide("slow", { search: () => new Promise(() => {}) });
} };`;

browserTest(h, "a sandboxed provider that never answers doesn't stop search", { scenario: "preview", open: "Welcome" }, async ({ page }) => {
  await install(page, "slowpoke", {
    "extension.json": JSON.stringify({ name: "Slowpoke", activationEvents: ["onStartup"], contributes: { search: { types: [{ type: "slow", title: "Slow" }] } } }),
    "index.js": SLOW,
  });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#command-bar input").fill("garden");
  await page.waitForTimeout(4000);
  const rows = await page.locator("#command-bar li").allTextContents();
  assert.ok(rows.length > 0, "notes still show while one extension's provider hangs");
});

const HIJACK = `export default { activate(ctx) {
  ctx.search.provide("task", { search: (q) => [{ title: "<img src=x onerror=window.top.__xss=1>Pay rent (fake)", detail: "<b>bold</b>", run: () => {} }] });
} };`;

browserTest(h, "a sandboxed extension can't take over another extension's kind of result", { scenario: "preview", open: "Welcome", allowErrors: [/Search type "task" belongs to tasks, not hijack/] }, async ({ page }) => {
  await install(page, "hijack", {
    "extension.json": JSON.stringify({ name: "Hijack", activationEvents: ["onStartup"], contributes: { search: { types: [{ type: "task", title: "Tasks" }] } } }),
    "index.js": HIJACK,
  });
  await page.reload();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#command-bar input").fill("pay");
  await page.locator("#command-bar ul:not([aria-busy])").waitFor({ state: "attached" });
  await page.waitForTimeout(500);
  const rows = await page.locator("#command-bar li").evaluateAll((lis) => lis.map((li) => (li.classList.contains("section") ? `[${li.textContent}]` : li.querySelector(".label")!.textContent!)));
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined, "no HTML from a provider runs");
  assert.equal(await page.locator("#command-bar img").count(), 0, "no HTML from a provider is drawn");
  assert.ok(rows.includes("Pay rent"), "Tasks' own task is still found");
  assert.ok(!rows.some((r) => r.includes("(fake)")) || rows.filter((r) => r === "[Tasks]").length === 2, "the hijacker doesn't answer under Tasks' section");
});

browserTest(h, "off a Mac, Ctrl-k and Ctrl-p in search move up the list and keep the query", { scenario: "preview", open: "Welcome" }, async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  await page.reload();
  await title(page, "Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await bar(page).waitFor();
  await field(page).pressSequentially("pay");
  await rows(page);
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+p");
  assert.equal(await field(page).inputValue(), "pay");
  assert.equal(await page.locator("#command-bar li[role=option]").first().getAttribute("aria-selected"), "true");
});

browserTest(h, "Tab with nothing to complete moves on to the chips, and the bar stays open", { scenario: "preview", open: "Welcome" }, async ({ page }) => {
  await title(page, "Welcome");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await field(page).fill("garden");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.matches("#command-bar .chips button:first-child")), true, "the first chip has focus");
  assert.equal(await bar(page).isVisible(), true);
});

browserTest(h, "offline, search says it needs a connection and still finds notes by name", { scenario: "preview", open: "Welcome", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] }, async (app) => {
  const { page } = app;
  await title(page, "Welcome");
  await app.call("idle");
  await page.context().setOffline(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await field(page).fill("garden");
  const found = await rows(page);
  assert.ok(found.includes("Search needs a connection: notes by name are below"), found.join(" | "));
  assert.ok(found.includes("Garden plan"), "by name still works");
  await page.context().setOffline(false);
});
