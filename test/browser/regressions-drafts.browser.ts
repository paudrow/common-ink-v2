// Bugs people found by hand (regressions.browser.ts says more): edits kept in this browser as drafts, with
// its storage blocked or offline, against the note on the server, and forgotten at sign-out.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { App } from "./pages.ts";

const h = harness();

/** A note's revision and text on the server. */
async function onServer(app: App, path = "Trip.md") {
  return (await (await app.page.context().request.get(`${app.base}/api/file?path=${encodeURIComponent(path)}`)).json()) as { revision: number; text: string };
}

/** Leave a draft in this browser as a page that went before hearing back would have. */
async function leaveDraft(app: App, draft: { text: string; base: number; edit: string }) {
  await app.page.evaluate((d) => localStorage.setItem(`common-ink.draft:${localStorage.getItem("common-ink:me")}:Trip.md`, JSON.stringify({ path: "Trip.md", time: Date.now(), ...d })), draft);
}

browserTest(h, "with this site's storage blocked, the app still opens a note and saves edits", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", { get: blocked });
    Object.defineProperty(IDBFactory.prototype, "open", { value: blocked });
  });
  await app.reload();
  await app.open("Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.idle();
  for (let i = 0; i < 20 && (await app.readFile("Trip.md")) !== "# Trip\n- packed\n"; i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
});

browserTest(h, "with storage blocked, edits waiting to be sent say they're lost if the page closes", { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      value: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await app.reload();
  await app.open("Trip");
  await app.idle();
  await app.page.context().setOffline(true);
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline · 1 unsent change, lost if this page closes");
  await app.page.context().setOffline(false);
});

browserTest(h, "going offline with nothing to send says Offline at once, and back online it goes at once", { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] }, async (app) => {
  await app.idle();
  await app.page.context().setOffline(true);
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline", null, { timeout: 1000 });
  await app.page.context().setOffline(false);
  // Nothing waiting to be sent, and nothing else asking the server: the page checks as it's back.
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "", null, { timeout: 3000 });
});

for (const [later, text] of [["deleted", "# Trip\n- a\n"], ["changed", "# Trip\n- a\n- packed bags\n"]] as const) {
  browserTest(h, `a kept edit the server already has isn't sent again when the note opens, though its line was ${later} since`, { scenario: "empty" }, async (app) => {
    await app.writeFile("Other.md", "# Other\n");
    await app.writeFile("Trip.md", "# Trip\n- a\n");
    const { revision: base } = await onServer(app);
    // The edit reached the server as the page went, with its id, but the page never heard: its draft stayed, on its old base.
    await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Trip.md", text: "# Trip\n- a\n- packed\n", base, edit: "went" } });
    await app.goto({}, "Other");
    await leaveDraft(app, { text: "# Trip\n- a\n- packed\n", base, edit: "went" });
    // Then another device changes the line.
    await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Trip.md", text, base: (await onServer(app)).revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
    await app.open("Trip");
    await app.idle();
    await app.page.waitForTimeout(800);
    await app.idle();
    assert.equal(await app.readFile("Trip.md"), text);
    assert.equal(await app.page.locator("#save").getAttribute("data-status"), "saved");
    assert.equal(await app.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("common-ink.draft:")).length), 0, "the draft is gone");
  });
}

for (const choice of ["Restore", "Discard"] as const) {
  browserTest(h, `a kept edit that never reached the server, on a note changed since, waits for you to ${choice.toLowerCase()} it`, { scenario: "empty" }, async (app) => {
    await app.writeFile("Other.md", "# Other\n");
    await app.writeFile("Trip.md", "# Trip\n- a\n");
    const { revision: base } = await onServer(app);
    await app.goto({}, "Other");
    await leaveDraft(app, { text: "# Trip\n- a\n- packed\n", base, edit: "lost" });
    await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Trip.md", text: "# Trip to Rome\n- a\n", base }, headers: { "X-Common-Ink-Agent": "Claude" } });
    await app.open("Trip");
    await app.idle();
    // Nothing's sent or merged unseen: the note stays as it is, and the status bar says there's an edit to settle.
    assert.equal(await app.readFile("Trip.md"), "# Trip to Rome\n- a\n");
    assert.equal(await app.page.locator("#save").getAttribute("data-status"), "conflict");
    assert.match((await app.page.locator("#save").textContent()) ?? "", /^Unsaved edit from \d{1,2}:\d\d/);
    await app.page.locator("#unsent", { hasText: "can't be merged" }).waitFor();
    await app.reload();
    await app.open("Trip");
    await app.idle();
    assert.equal(await app.page.locator("#save").getAttribute("data-status"), "conflict", "a reload keeps it to settle");
    await app.command("Compare your edit with the one it clashes with, and keep yours or theirs");
    const dialog = app.page.locator(".clash");
    await dialog.locator("h2", { hasText: /^Unsaved edit from / }).waitFor();
    await dialog.locator("button", { hasText: choice }).click();
    await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "saved");
    await app.idle();
    // Restored, it goes onto the note as it is now: the other edit stays.
    assert.equal(await app.readFile("Trip.md"), choice === "Restore" ? "# Trip to Rome\n- a\n- packed\n" : "# Trip to Rome\n- a\n");
    assert.equal(await app.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("common-ink.draft:")).length), 0, "nothing's kept now");
    assert.equal(await app.page.locator("#unsent").textContent(), "");
  });
}

browserTest(h, "restoring a kept edit that changed the same line as the note since shows the two, to keep yours or use theirs", { scenario: "empty" }, async (app) => {
  await app.writeFile("Other.md", "# Other\n");
  await app.writeFile("Trip.md", "# Trip\n- a\n");
  const { revision: base } = await onServer(app);
  await app.goto({}, "Other");
  await leaveDraft(app, { text: "# Trip to Paris\n- a\n", base, edit: "lost" });
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Trip.md", text: "# Trip to Rome\n- a\n", base }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.open("Trip");
  await app.idle();
  await app.command("Compare your edit with the one it clashes with, and keep yours or theirs");
  await app.page.locator(".clash button", { hasText: "Restore" }).click();
  const dialog = app.page.locator(".clash");
  await dialog.locator("h2", { hasText: "Your version and theirs" }).waitFor();
  assert.equal(await app.readFile("Trip.md"), "# Trip to Rome\n- a\n", "nothing's saved until you choose");
  await dialog.locator("button", { hasText: "Keep mine" }).click();
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "saved");
  await app.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip to Paris\n- a\n");
});

browserTest(h, "signing out forgets this browser's kept edits, so the next account can't get them", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.call("slow", "^PUT /api/file", 60_000);
  await app.keys("o- private<Esc>");
  const gone = app.page.waitForURL(/sign-out/);
  await app.command("Sign out");
  await gone;
  await app.page.waitForLoadState("load");
  assert.deepEqual(await app.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("common-ink.draft:"))), []);
});

browserTest(h, "signing out in another tab stops this one keeping its typing", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.call("slow", "^PUT /api/file", 60_000);
  await app.keys("o- private<Esc>");
  const other = new App(await app.page.context().newPage(), app.base);
  await other.goto({}, "Other");
  await other.idle();
  const gone = other.page.waitForURL(/sign-out/);
  await other.command("Sign out");
  await gone;
  await other.page.waitForLoadState("load");
  await app.keys("o- more private<Esc>");
  await app.page.goto("about:blank");
  const drafts = () => other.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("common-ink.draft:")));
  assert.deepEqual(await drafts(), []);
  await other.page.close();
});

browserTest(h, "a sign-out typed in the address bar straight after typing leaves nothing of it to come back", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.call("slow", "^(PUT /api/file|POST /api/file/beacon)", 60_000);
  await app.keys("o- private<Esc>");
  // The page can't see where it's going: it keeps its draft as it goes, after sign-out cleared storage.
  await app.page.goto(`${app.base}/auth/sign-out`);
  await app.goto({}, "Trip");
  await app.idle();
  await app.page.waitForTimeout(800);
  assert.equal(await app.readFile("Trip.md"), "# Trip\n");
  assert.deepEqual(await app.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("common-ink.draft:"))), []);
});

browserTest(h, "a session that's over forgets the drafts kept for it", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await leaveDraft(app, { text: "# Trip\n- private\n", base: 1, edit: "p" });
  await app.page.route("**/api/me", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in" }) }));
  await app.page.reload();
  await app.page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith("common-ink.draft:")));
});

browserTest(h, "a note deleted elsewhere while it's open isn't written back when its tab closes", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n- packed\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.goto({}, "Trip");
  await app.idle();
  const { revision } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Trip.md`)).json()) as { revision: number };
  const res = await app.page.context().request.fetch(`${app.base}/api/file`, { method: "DELETE", data: { path: "Trip.md", base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  assert.ok(res.ok(), `${res.status()}`);
  await app.page.waitForTimeout(800);
  await app.idle();
  await app.command("Close tab");
  await app.page.waitForTimeout(800);
  await app.idle();
  const after = await app.page.context().request.get(`${app.base}/api/file?path=Trip.md`);
  assert.equal(((await after.json()) as { revision: number; text: string }).text ?? "", "");
});

browserTest(h, "an edit that clashes with someone else's is still there, clashing, after a reload", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  const { revision, text } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number; text: string };
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: text.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  const clashing = async () => ((await app.state()) as { pending: Array<{ path: string; status: string }> }).pending.some((p) => p.path === "Plan.md" && p.status === "conflict");
  for (let i = 0; i < 40 && !(await clashing()); i++) await app.page.waitForTimeout(250);
  assert.ok(await clashing(), "it clashes");
  await app.call("cursor", 5, 1);
  await app.keys("A too<Esc>");
  await app.page.waitForTimeout(300);
  await app.reload();
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta mine" }).waitFor();
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "gamma too" }).waitFor();
  assert.ok(await clashing(), "it still clashes");
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma\n", "theirs is what the server has");
});
