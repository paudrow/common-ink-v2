// An edit of yours that clashes with an agent's, in a real browser against the real Worker: the status
// bar says it isn't saved, online or back from offline, and Compare shows both versions, to keep
// yours (theirs stays in History) or use theirs (u brings yours back).
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
const NOTE = "# Plan\n\nalpha\nbeta\ngamma\n";
const OFFLINE = [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/];

/** An agent changes the line you're editing, on the revision your editor has. */
async function agentWrites(app: App, revision: number) {
  const res = await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: NOTE.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  assert.ok(res.ok(), `${res.status()}`);
}

async function open(app: App) {
  await app.writeFile("Plan.md", NOTE);
  await app.goto({}, "Plan");
  await app.idle();
  const res = await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`);
  return ((await res.json()) as { revision: number }).revision;
}

const clashShown = (app: App) => app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "conflict" && !document.querySelector<HTMLElement>("#resolve")!.hidden);

browserTest(h, "an agent's edit to the line you're typing on: the status bar says it isn't saved, and Keep mine saves yours over theirs", { scenario: "empty" }, async (app) => {
  const revision = await open(app);
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await agentWrites(app, revision);
  await clashShown(app);
  assert.equal(await app.page.locator("#save").textContent(), "Not saved: this note changed in the same place elsewhere.");
  assert.equal(await app.page.locator("#unsent").textContent(), "1 can't be merged: open Plan");
  await app.page.locator("#resolve").click();
  const dialog = app.page.locator(".clash");
  await dialog.waitFor();
  assert.match(await dialog.locator("p").first().textContent() ?? "", /^Claude \(for you\) changed Plan/);
  assert.deepEqual(await dialog.locator(".diff span").allTextContents(), ["- beta theirs\n", "+ beta mine\n"]);
  await dialog.locator("button", { hasText: "Keep mine" }).click();
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), NOTE.replace("beta", "beta mine"));
  await app.page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  assert.equal(await app.page.locator("#resolve").isHidden(), true);
  assert.equal(await app.page.locator("#unsent").textContent(), "");
});

browserTest(h, "Use theirs puts their version in the editor, and u brings yours back to be saved", { scenario: "empty" }, async (app) => {
  const revision = await open(app);
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await agentWrites(app, revision);
  await clashShown(app);
  await app.command("note.resolveConflict");
  await app.page.locator(".clash button", { hasText: "Use theirs" }).click();
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), NOTE.replace("beta", "beta theirs"));
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta theirs" }).waitFor();
  await app.keys("u");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta mine" }).waitFor();
  await app.call("command", "note.save");
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), NOTE.replace("beta", "beta mine"));
});

browserTest(h, "an edit made offline that clashes says so once back online, instead of waiting to be sent", { scenario: "empty", allowErrors: OFFLINE }, async (app) => {
  const revision = await open(app);
  const context = app.page.context();
  await context.setOffline(true);
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline · 1 unsent change");
  await agentWrites(app, revision);
  await context.setOffline(false);
  await clashShown(app);
  assert.equal(await app.page.locator("#unsent").textContent(), "1 unsent change · 1 can't be merged: open Plan");
  await app.page.locator("#unsent").click();
  await app.page.locator(".clash button", { hasText: "Keep mine" }).click();
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), NOTE.replace("beta", "beta mine"));
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "");
});
