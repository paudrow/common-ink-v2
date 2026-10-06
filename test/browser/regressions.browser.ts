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

browserTest(h, "resizing a window with a Kanban board in it reports no ResizeObserver loop", { scenario: "tasks", open: "Boards tour.md" }, async (app) => {
  await app.idle();
  for (const keys of [":vs Boards tour<CR>", "<C-w>>", "<C-w>>", "<C-w><", "<C-w>=", "<C-w>H", "<C-w>c"]) {
    await app.keys(`<Esc>${keys}`);
    await app.page.waitForTimeout(300);
  }
  const problems = ((await app.state()) as { problems: Array<{ message: string }> }).problems.map((p) => p.message);
  assert.deepEqual(problems, []);
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
