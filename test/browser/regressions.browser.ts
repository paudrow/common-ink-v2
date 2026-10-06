// Bugs people found by hand, pinned down so they stay fixed (docs/TESTING.md says how to add one). Each
// test names what went wrong. Others are pinned elsewhere: Copy writing to the clipboard in the click (test/markdown-extensions.test.ts
// and default-extensions.browser.ts), and a site's embed showing nothing behind its corners
// (link-embeds.browser.ts).
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { App } from "./pages.ts";

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

for (const leave of ["a reload", "leaving the page"] as const) {
  browserTest(h, `${leave} straight after an edit keeps it, every time`, { scenario: "empty" }, async (app) => {
    for (let run = 0; run < 8; run++) {
      await app.writeFile("Trip.md", "# Trip\n");
      await app.goto({}, "Trip");
      await app.idle();
      await app.call("cursor", 1, 7);
      // The page goes before the edit reaches the server: the requests that carry it never get out.
      await app.call("slow", "^PUT /api/file", 60_000);
      await app.keys(`o- packed ${run}<Esc>`);
      if (leave === "a reload") await app.page.reload();
      else await app.page.goto("about:blank");
      await app.goto({}, "Trip");
      await app.idle();
      let text = "";
      for (let i = 0; i < 20 && (text = await app.readFile("Trip.md")) !== `# Trip\n- packed ${run}\n`; i++) await app.page.waitForTimeout(250);
      assert.equal(text, `# Trip\n- packed ${run}\n`, `run ${run}`);
    }
  });
}

/** A note's revision and text on the server. */
async function onServer(app: App, path = "Trip.md") {
  return (await (await app.page.context().request.get(`${app.base}/api/file?path=${encodeURIComponent(path)}`)).json()) as { revision: number; text: string };
}

/** Leave a draft in this browser as a page that went before hearing back would have. */
async function leaveDraft(app: App, draft: { text: string; base: number; edit: string }) {
  await app.page.evaluate((d) => localStorage.setItem(`common-ink.draft:${localStorage.getItem("common-ink:me")}:Trip.md`, JSON.stringify({ path: "Trip.md", time: Date.now(), ...d })), draft);
}

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

browserTest(h, "an edit sent by beacon as the page went, and kept as a draft too, lands once", { scenario: "empty" }, async (app) => {
  for (let run = 0; run < 4; run++) {
    await app.writeFile("Trip.md", "# Trip\n");
    await app.goto({}, "Trip");
    await app.idle();
    await app.call("cursor", 1, 7);
    // The editor's own saves held back: only the beacon, and the draft kept as the page goes, carry the edit.
    await app.call("slow", "^PUT /api/file", 60_000);
    await app.keys(`o- packed ${run}<Esc>`);
    await app.page.goto("about:blank");
    await app.page.waitForTimeout(500);
    await app.goto({}, "Trip");
    await app.idle();
    await app.page.waitForTimeout(800);
    await app.idle();
    assert.equal(await app.readFile("Trip.md"), `# Trip\n- packed ${run}\n`, `run ${run}: once`);
  }
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
  await app.call("slow", "^PUT /api/file", 60_000);
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

browserTest(h, "Vim's visual block inserts, appends and deletes on every line it covers, lists too", { scenario: "empty" }, async (app) => {
  await app.writeFile("V.md", "# V\n\nabc\ndef\nghi\n\n- one\n- two\n- three\n");
  await app.goto({}, "V");
  await app.idle();
  await app.call("cursor", 3, 3);
  await app.keys("<C-v>jjIx <Esc>");
  await app.call("cursor", 3, 1);
  await app.keys("<C-v>jj$A!<Esc>");
  await app.call("cursor", 7, 3);
  await app.keys("<C-v>jjI* <Esc>");
  await app.call("cursor", 3, 1);
  await app.keys("<C-v>jjd");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("V.md")).includes("bx c!"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("V.md"), "# V\n\nbx c!\nex f!\nhx i!\n\n- * one\n- * two\n- * three\n");
});

browserTest(h, "a click with ⌘ or Ctrl, or ⌘⌥↓, doesn't leave a second cursor for the next dd", { scenario: "empty" }, async (app) => {
  await app.writeFile("C.md", "# C\n\none\ntwo\nthree\n");
  await app.goto({}, "C");
  await app.idle();
  const ranges = () => app.page.evaluate(async () => {
    const { EditorView } = await (globalThis as unknown as { __commonInkLibrary(n: string): Promise<{ EditorView: { findFromDOM(e: Element): { state: { selection: { ranges: unknown[] } } } } }> }).__commonInkLibrary("@codemirror/view");
    return EditorView.findFromDOM(document.querySelector(".tab-editor:not([hidden]) .cm-editor")!).state.selection.ranges.length;
  });
  await app.call("cursor", 3, 1);
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "three" }).click({ modifiers: ["ControlOrMeta"] });
  assert.equal(await ranges(), 1, "the click moved the cursor, it didn't add one");
  await app.page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  assert.equal(await ranges(), 1, "⌘⌥↓ adds none");
  await app.keys("<Esc>dd");
  await app.idle();
  for (let i = 0; i < 20 && (await app.readFile("C.md")).includes("three"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("C.md"), "# C\n\none\ntwo\n");
});

browserTest(h, "Vim's > over a paragraph and the list after it shifts every line, and leaves the cursor on the first", { scenario: "empty" }, async (app) => {
  await app.writeFile("P.md", "# P\n\nSome text\nmore text\n- one\n- two\n\nend\n");
  await app.goto({}, "P");
  await app.idle();
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>>ip");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("P.md")).includes("  Some"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("P.md"), "# P\n\n  Some text\n  more text\n  - one\n  - two\n\nend\n");
  assert.deepEqual([(await where(app)).line, (await where(app)).column], [3, 3], "on the first line's first character, as Vim leaves it");
  await app.keys("u");
  await app.call("cursor", 4, 1);
  await app.keys("3<<");
  await app.call("cursor", 4, 1);
  await app.keys("3>>");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("P.md")).includes("  more"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("P.md"), "# P\n\nSome text\n  more text\n  - one\n  - two\n\nend\n");
  assert.equal((await where(app)).line, 4);
});

browserTest(h, "j and k go a line at a time through blocks side by side, at the very start and end of a note too", { scenario: "empty" }, async (app) => {
  // Math, a table, a code block and math again, then a task and a table that ends the note.
  const text = "$$\nx^2\n$$\n| a | b |\n|--|--|\n| 1 | 2 |\n```js\nlet a = 1\n```\n$$\ny\n$$\n- [ ] task\n| c |\n|--|\n| 3 |";
  await app.writeFile("Edges.md", text);
  await app.goto({}, "Edges");
  await app.idle();
  await app.call("cursor", 1, 1);
  const lines: number[] = [];
  for (let i = 0; i < 16; i++) {
    lines.push((await where(app)).line);
    await app.keys(i < 15 ? "j" : "");
  }
  for (let i = 0; i < 15; i++) {
    await app.keys("k");
    lines.push((await where(app)).line);
  }
  const numbers = Array.from({ length: 16 }, (_, i) => i + 1);
  assert.deepEqual(lines, [...numbers, ...numbers.reverse().slice(1)]);
});

browserTest(h, "around a table or math block at a note's start or end, G, gg, counts and clicks go where they're sent", { scenario: "empty", viewport: { width: 1200, height: 1000 } }, async (app) => {
  const line = async (keys: string, from: number) => {
    await app.call("cursor", from, 1);
    await app.keys(keys);
    await app.page.waitForTimeout(100);
    return (await where(app)).line;
  };
  for (const [kind, block] of [["table", ["| a | b |", "|--|--|", "| 1 | 2 |"]], ["math", ["$$", "x^2", "$$"]]] as const) {
    await app.writeFile("End.md", ["top", "", ...block].join("\n"));
    await app.goto({}, "End");
    await app.idle();
    assert.deepEqual([await line("G", 1), await line("G", 2), await line("3j", 1), await line("5j", 1), await line("2j", 2), await line("3j", 2), await line("j", 2)], [5, 5, 5, 5, 5, 5, 3], `${kind} at the end: G, G, 3j, 5j, 2j, 3j, j`);
    // A mark named j: 'j goes to its line, not one step.
    await app.call("cursor", 5, 1);
    await app.keys("mj");
    assert.equal(await line("'j", 2), 5, `${kind} at the end: 'j`);
    await app.writeFile("Start.md", [...block, "", "end"].join("\n"));
    await app.goto({}, "Start");
    await app.idle();
    assert.deepEqual([await line("gg", 5), await line("gg", 4), await line("2k", 5), await line("3k", 5), await line("5k", 5), await line("2k", 4), await line("3k", 4), await line("k", 4)], [1, 1, 1, 1, 1, 1, 1, 3], `${kind} at the start: gg, gg, 2k, 3k, 5k, 2k, 3k, k`);
    // A click on the drawn block puts the cursor where it was clicked: in the block, which shows its markdown.
    await app.call("cursor", 5, 1);
    await app.page.locator(kind === "table" ? ".tab-editor:not([hidden]) .cm-content td" : ".tab-editor:not([hidden]) .cm-content .katex").first().click();
    await app.page.waitForTimeout(100);
    assert.equal((await where(app)).line, 1, `a click on the ${kind}`);
  }
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

browserTest(h, "with reduced motion asked for, nothing on screen pulses or flashes in a loop", { scenario: "empty" }, async (app) => {
  await app.page.emulateMedia({ reducedMotion: "reduce" });
  const looping = await app.page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((e) => {
      const s = getComputedStyle(e);
      // The text cursor blinks, as the system's own does.
      if (e.closest(".cm-cursorLayer")) return [];
      return s.animationName !== "none" && s.animationIterationCount === "infinite" ? [e.id || e.className.toString()] : [];
    }),
  );
  assert.deepEqual(looping, []);
});
