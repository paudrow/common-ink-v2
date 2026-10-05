// Test levers in a real browser (docs/TESTING.md): the clock, permission answers, the replayed network,
// going offline and resetting to a scenario, each driven the way a test or an agent would.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const chip = (app: { page: import("playwright-core").Page }, todo: string) =>
  app.page.locator(".cm-line", { hasText: todo }).locator('.tk[data-field="due"]').first().textContent();

browserTest(h, "a scenario's clock dates its todos, ?now= moves the page's clock, and the clock keeps running across a reload", { scenario: "todos", open: "Chores" }, async (app) => {
  assert.match((await app.state()).clock, /^2026-10-0[45]T/, "the scenario's own day");
  await app.page.waitForSelector(".tab-editor:not([hidden]) .tk");
  assert.equal(await chip(app, "Water the plants"), "Today");
  await app.goto({ now: "2026-10-07T09:00" }, "Chores");
  await app.page.waitForSelector(".tab-editor:not([hidden]) .tk");
  assert.equal(await chip(app, "Water the plants"), "Oct 5", "two days ago");
  const before = Date.parse((await app.state()).clock);
  await app.reload();
  const after = Date.parse((await app.state()).clock);
  assert.ok(after >= before && after - before < 60_000, "after a reload the clock picks up where it was");
  await app.call("levers.set", { now: null });
  assert.match((await app.state()).clock, /^2026-10-0[45]T/, "cleared, it's back to the scenario's");
});

browserTest(h, "permissions=allow answers a sandboxed extension's prompt with Allow once and keeps nothing; deny refuses it for the session", { scenario: "extensions", levers: { permissions: "allow" } }, async (app) => {
  await app.command("Show word count");
  const view = app.page.frameLocator("iframe.webview");
  await view.locator("body", { hasText: /\d+ words?/ }).waitFor();
  const shown = await app.prompt.shown();
  assert.deepEqual(shown.map(({ extension, asks, auto, answer }) => ({ extension, asks, auto, answer })), [{ extension: "word-count", asks: ["files:read:**/*.md"], auto: true, answer: "once" }]);
  assert.deepEqual((await app.state()).permissions.grants, {}, "nothing kept in settings");
  await app.goto({ permissions: "deny" });
  await app.command("Show word count");
  await view.locator("body", { hasText: "you didn't allow it this time" }).waitFor();
  assert.equal(await app.prompt.dialog().count(), 0, "no dialog either way");
});

browserTest(h, "net=replay: a link card comes from the recordings, and a page that isn't recorded stays a link", { levers: { net: "replay" }, allowErrors: [/status of 400/] }, async (app) => {
  await app.writeFile("Cards.md", "# Cards\n\nhttps://recorded.example/pen\n\nhttps://recorded.example/missing\n\nEnd.\n");
  await app.open("Cards");
  await app.page.locator(".link-card .title", { hasText: "A recorded pen" }).waitFor();
  await app.page.locator('.cm-url-embed a.cm-md-link[href="https://recorded.example/missing"]').waitFor();
  const activity = (await app.state()) as unknown as { activity: Array<{ url?: string; outcome: string }> };
  assert.ok(activity.activity.some((a) => a.url?.includes("recorded.example/missing") && a.outcome === "failed"), "the missing one failed, in Extension activity");
});

browserTest(h, "offline: edits wait, the status bar says so, and they reach the server once it's back", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.call("levers.set", { offline: true });
  await app.editor.at(5);
  await app.keys("A, soon<Esc>");
  await app.page.locator("#unsent", { hasText: "Offline" }).waitFor();
  assert.doesNotMatch(await app.readFile("Lists tour.md"), /garden, soon/);
  await app.call("levers.set", { offline: false });
  await app.idle();
  assert.match(await app.readFile("Lists tour.md"), /- Plan the garden, soon\n/);
});

browserTest(h, "reset empties the workspace back to its scenario, revisions keep counting up, and the page starts over", { scenario: "lists" }, async (app) => {
  await app.writeFile("Scratch.md", "# Scratch\n");
  const before = Math.max(...(await app.state()).history.map((c) => c.revision));
  const reloaded = app.page.waitForEvent("load");
  await app.call("reset");
  await reloaded;
  await app.ready();
  const after = await app.state();
  assert.deepEqual([...new Set(after.history.map((c) => c.path))].sort(), [".common-ink/layout.json", "Lists tour.md"]);
  assert.ok(Math.min(...after.history.map((c) => c.revision)) > before, "the new seed's revisions come after the old ones");
  assert.equal(after.focus.path, "Lists tour.md", "opens on the scenario's note");
});

browserTest(h, "the inspector drives Vim with key events, as an agent's browser tool would, and reports windows, mode and cursor", { scenario: "lists", open: "Lists tour" }, async (app) => {
  await app.call("keys", "/Basil<CR>");
  const { line, column, text } = (await app.editor.cursor())!;
  assert.deepEqual({ line, column, text }, { line: 8, column: 7, text: "    - Basil" });
  await app.call("keys", "i");
  assert.equal(await app.editor.mode(), "insert");
  await app.call("keys", "Sweet <Esc>:vs<CR>");
  const state = await app.state();
  assert.equal(state.vim?.mode, "normal");
  assert.equal(state.windows.length, 2);
  assert.equal(state.cursor?.text, "    - Sweet Basil");
  await app.call("keys", "<C-w>o");
  assert.equal((await app.state()).windows.length, 1);
});
