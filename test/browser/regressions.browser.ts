// Bugs people found by hand, pinned down so they stay fixed (docs/TESTING.md says how to add one). Each
// test names what went wrong. Others are pinned elsewhere: Copy writing to the clipboard in the click (test/markdown-extensions.test.ts
// and default-extensions.browser.ts), and a site's embed showing nothing behind its corners
// (link-embeds.browser.ts).
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const where = (app: App) => app.call<{ path: string; line: number; column: number; lines: number; mode: string | null }>("where");

browserTest(h, "task chips, checkboxes, bullets, numbers and inline math never sit over a line's text, wide or narrow", { scenario: "tasks" }, async (app) => {
  for (const width of [1100, 420]) {
    await app.page.setViewportSize({ width, height: 800 });
    for (const note of ["Chores", "Task edge cases"]) {
      await app.open(note);
      await app.page.waitForSelector(".tab-editor:not([hidden]) .tk");
      assert.deepEqual(await app.call("check.overlaps"), [], `${note} at ${width}px`);
    }
  }
});

browserTest(h, "a window left alone after its split closes fills the workbench again, however the split closed", { scenario: "lists", open: "Lists tour" }, async (app) => {
  const full = (await app.page.locator("#workbench").boundingBox())!;
  const fills = async (how: string) => {
    assert.deepEqual(await app.call("check.layoutFill"), [], how);
    const [only] = await app.tabs.windows();
    assert.ok(Math.abs(only.rect.width - full.width) < 2, `${how}: ${only.rect.width}px of ${full.width}px`);
  };
  await app.keys(":vs<CR>");
  await app.page.waitForFunction(() => document.querySelectorAll("section.group").length === 2);
  assert.deepEqual(await app.call("check.layoutFill"), [], "two windows, half each");
  await app.keys("<C-w>c");
  await fills("Ctrl-W c");
  await app.keys(":sp<CR>:vs<CR>");
  await app.page.waitForFunction(() => document.querySelectorAll("section.group").length === 3);
  assert.deepEqual(await app.call("check.layoutFill"), [], "three windows");
  await app.command("Close tab");
  await app.command("Close tab");
  await fills("closing each split's only tab");
});

browserTest(
  h,
  "a list item's text stays where it is when the cursor comes onto its line",
  { scenario: "lists", open: "Lists tour" },
  async (app) => {
    const { lines } = (await where(app))!;
    const items = await app.page.evaluate(() => [...document.querySelectorAll(".cm-line")].length);
    assert.ok(items > 20 && lines === 33);
    // Lines 5 to 24 are the tour's bullets, numbered items and tasks.
    assert.deepEqual(await app.call("check.lineShift", Array.from({ length: 20 }, (_, i) => i + 5)), []);
  },
);

browserTest(h, "a tab click lands even when the tabs redraw between the press and the release", { scenario: "tasks", open: "Chores" }, async (app) => {
  await app.keys(":tabe Task edge cases<CR>");
  await app.page.waitForFunction(() => document.title.startsWith("Task edge cases"));
  // An unsaved edit: pressing a tab moves focus off the editor, which saves, which redraws the tabs.
  const press = async (target: import("playwright-core").Locator) => {
    await app.keys("Ax<Esc>");
    const box = (await target.boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.idle();
    await app.page.mouse.up();
  };
  await press(app.tabs.tab(0, "Chores").locator(".name"));
  assert.equal(await app.tabs.selected(), "Chores");
  await app.page.waitForFunction(() => document.title.startsWith("Chores"));
  await press(app.tabs.tab(0, "Task edge cases").locator(".close"));
  await app.idle();
  assert.deepEqual((await app.tabs.windows())[0].tabs.map((t) => t.label), ["Chores"]);
});

browserTest(h, "one answer to a permission prompt is enough, however many times the extension asks while it's up or being kept", { scenario: "extensions" }, async (app) => {
  await app.command("Show word count");
  await app.prompt.waitFor();
  // A note saved while the prompt is up: Word count counts again, and that ask joins the prompt on screen.
  await app.writeFile("Extension ideas.md", "# Extension ideas\n\nOne more.\n");
  await app.page.waitForTimeout(800);
  assert.equal(await app.prompt.dialog().count(), 1);
  // Keeping the answer in settings takes a while here, and another save makes Word count ask in that while.
  await app.call("slow", "^PUT /api/file", 2500);
  await app.prompt.answer("Don't allow");
  await app.writeFile("Extension ideas.md", "# Extension ideas\n\nAnd another.\n");
  await app.page.waitForTimeout(1200);
  assert.equal(await app.prompt.dialog().count(), 0, "not asked again while the answer is kept");
  await app.call("slow");
  await app.page.frameLocator("iframe.webview").locator("body", { hasText: "you don't allow it" }).waitFor();
  await app.idle();
  const shown = await app.prompt.shown();
  assert.deepEqual(shown.map(({ extension, answer }) => ({ extension, answer })), [{ extension: "word-count", answer: "deny" }]);
  assert.deepEqual((await app.state()).permissions.grants, { "word-count": { "files:read:**/*.md": "deny" } });
});

browserTest(h, "j visits every line of a note in order, through tables, math, code blocks and embeds, and k comes back the same way", { scenario: "embeds" }, async (app) => {
  for (const note of ["Markdown extras", "Embeds tour"]) {
    await app.open(note);
    await app.editor.at(1);
    const { lines } = (await where(app))!;
    const down: number[] = [];
    for (let i = 0; i < lines * 2 && down.at(-1) !== lines; i++) {
      await app.keys("j");
      down.push((await where(app))!.line);
    }
    const skips = down.flatMap((line, i) => (line - (down[i - 1] ?? 1) > 1 ? [`${down[i - 1] ?? 1} to ${line}`] : []));
    assert.deepEqual(skips, [], `${note}: j skipped lines`);
    assert.equal(down.at(-1), lines, `${note}: j reached the last line`);
    const up: number[] = [];
    for (let i = 0; i < lines * 2 && up.at(-1) !== 1; i++) {
      await app.keys("k");
      up.push((await where(app))!.line);
    }
    const back = up.flatMap((line, i) => ((up[i - 1] ?? lines) - line > 1 ? [`${up[i - 1] ?? lines} to ${line}`] : []));
    assert.deepEqual(back, [], `${note}: k skipped lines`);
  }
});

browserTest(h, "closing a note's tab after an edit keeps the edit, rather than putting back the note as it opened", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  await app.command("Close tab");
  await app.page.waitForTimeout(500);
  await app.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
});

browserTest(h, "moving an edited note's tab to another window shows and keeps the edit", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  await app.keys(":vs Other<CR>");
  await app.idle();
  await app.keys("<C-w>h<C-w>L");
  await app.page.waitForTimeout(500);
  await app.idle();
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "packed" }).waitFor();
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
});

browserTest(h, "closing a split, or one of two windows on the same note, keeps the note's edits", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.keys(":vs<CR>");
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  await app.keys("<C-w>c");
  await app.page.waitForTimeout(500);
  await app.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n", "one of two windows on it closed");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "packed" }).waitFor();
  await app.keys(":vs Other<CR>");
  await app.idle();
  await app.keys("<C-w>h");
  await app.call("cursor", 2, 1);
  await app.keys("o- passport<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  await app.keys("<C-w>c");
  await app.page.waitForTimeout(500);
  await app.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n- passport\n", "its only window closed");
});

browserTest(h, "an edited note moved to another window while offline is sent once back online", { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.keys(":vs Other<CR>");
  await app.idle();
  await app.keys("<C-w>h");
  await app.page.context().setOffline(true);
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline · 1 unsent change");
  await app.keys("<C-w>L");
  await app.page.waitForTimeout(500);
  await app.page.context().setOffline(false);
  for (let i = 0; i < 40 && (await app.readFile("Trip.md")) !== "# Trip\n- packed\n"; i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
});

browserTest(h, "a reload straight after an edit keeps it", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.reload();
  await app.idle();
  for (let i = 0; i < 20 && (await app.readFile("Trip.md")) !== "# Trip\n- packed\n"; i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
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

browserTest(h, "moving through lists and tasks with j and k shifts nothing on screen but the cursor", { scenario: "tasks" }, async (app) => {
  for (const [note, keys] of [["Chores", "jjjjjjjkkkkkkk"], ["Lists tour", ""]] as const) {
    if (!keys) {
      await app.reset("lists");
      await app.goto({}, note);
    } else await app.open(note);
    await app.idle();
    const since = await app.page.evaluate(() => performance.now());
    await app.editor.at(1);
    await app.keys(keys || "jjjjjjjjjjjjjjjjjjjjjjjjjkkkkkkkkkkkkkkkkkkkkkkkkk");
    await app.page.waitForTimeout(300);
    // A line's own text reflows as its raw markdown shows; what mustn't happen is lines moving up or down.
    const shifts = await app.call<Array<{ moved: Array<{ node: string; dx: number; dy: number }> }>>("check.layoutShifts", since);
    assert.deepEqual(shifts.flatMap((s) => s.moved.filter((m) => !m.node.includes("cm-cursor") && Math.abs(m.dy) > 1)), [], note);
  }
});

browserTest(h, "the settings editor's User and Workspace each show their own values", { scenario: "empty" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "tasks.chips": false }));
  await app.settings.open("user");
  const chips = app.settings.control("tasks.chips");
  await chips.waitFor();
  assert.equal(await chips.locator(".badge", { hasText: "Modified" }).count(), 1, "set in user settings");
  await app.settings.switchTo("Workspace");
  assert.equal(await chips.locator(".badge", { hasText: "Modified" }).count(), 0, "not set in workspace settings");
  await app.settings.switchTo("User");
  assert.equal(await chips.locator(".badge", { hasText: "Modified" }).count(), 1);
});
