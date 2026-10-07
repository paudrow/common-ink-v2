// Bugs people found by hand (regressions.browser.ts says more): what Vim's u takes back, around clashes
// with someone else's change too.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

browserTest(h, "a clash undone, then redone, writes nothing: its redo would land where theirs has moved", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  const { revision, text } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number; text: string };
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: text.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "conflict");
  await app.keys("u");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta theirs" }).waitFor();
  await app.keys("<C-r>");
  await app.page.waitForTimeout(2000);
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma\n");
});

browserTest(h, "a clash undone back to where it started is no clash, and the note takes in theirs", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  const { revision, text } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number; text: string };
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: text.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "conflict");
  await app.keys("u");
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "saved");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta theirs" }).waitFor();
  await app.reload();
  await app.open("Plan");
  await app.idle();
  await app.page.waitForTimeout(800);
  assert.equal(await app.page.locator("#save").getAttribute("data-status"), "saved");
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma\n");
});

browserTest(h, "after a clash undone starts the undo history afresh, a change typed slowly in insert mode is still one undo step", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  const { revision, text } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number; text: string };
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: text.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "conflict");
  await app.keys("u");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta theirs" }).waitFor();
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "saved");
  await app.call("cursor", 5, 1);
  await app.keys("A one");
  await app.page.waitForTimeout(700);
  await app.keys("<CR>two<Esc>");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("Plan.md")).includes("two"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma one\ntwo\n");
  await app.keys("u");
  await app.idle();
  for (let i = 0; i < 20 && (await app.readFile("Plan.md")).includes("one"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma\n", "the insert went in one step");
  await app.keys("u");
  await app.page.waitForTimeout(800);
  await app.idle();
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha\nbeta theirs\ngamma\n", "and nothing from before the clash is left to undo");
});

browserTest(h, "a clash typed away in insert mode starts the undo history afresh, and the rest of that insert is one undo step", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  await app.call("cursor", 3, 1);
  await app.keys("A first<Esc>");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("Plan.md")).includes("first"); i++) await app.page.waitForTimeout(250);
  const { revision, text } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number; text: string };
  await app.call("cursor", 4, 1);
  await app.keys("A mine");
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: text.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "conflict");
  await app.keys("<BS><BS><BS><BS><BS>");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "beta theirs" }).waitFor();
  await app.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "saved");
  // Taking in theirs put the cursor at the line's start; still in insert mode, it goes to the end.
  await app.keys("<End> one");
  await app.page.waitForTimeout(700);
  await app.keys(" two<Esc>");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("Plan.md")).includes("two"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha first\nbeta theirs one two\ngamma\n");
  await app.keys("u");
  await app.idle();
  for (let i = 0; i < 20 && (await app.readFile("Plan.md")).includes("one"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nalpha first\nbeta theirs\ngamma\n", "what was typed after the clash went in one step");
});

browserTest(h, "Vim's u takes back a whole change, typed however slowly: cw, o, A, a block's I and a . each go in one step", { scenario: "empty", timeout: 300_000 }, async (app) => {
  const START = "# U\n\nabcd\nefgh\nijkl\nmnop\n";
  // Each key more than half a second after the last: further apart than edits are joined otherwise.
  const slowly = async (keys: string[]) => {
    for (const k of keys) {
      await app.keys(k);
      await app.page.waitForTimeout(600);
    }
  };
  for (const [name, keys, after] of [
    ["cw", ["cw", "Z", "Y", "<Esc>", "u"], START],
    ["o", ["o", "H", "i", "<Esc>", "u"], START],
    ["A", ["A", "!", "?", "<Esc>", "u"], START],
    ["a block's I", ["<C-v>jjI", "X", "Y", "<Esc>", "u"], START],
    // Enter in insert mode is typing too.
    ["A…<CR>…", ["A", "x", "<CR>", "y", "<Esc>", "u"], START],
    ["cw…<CR>…", ["cw", "Z", "<CR>", "Y", "<Esc>", "u"], START],
    ["o…<CR>…", ["o", "H", "<CR>", "i", "<Esc>", "u"], START],
    ["S with two Enters", ["S", "a", "<CR>", "b", "<CR>", "c", "<Esc>", "u"], START],
    // The second change, made by ., is the step u takes back.
    [".", ["cwZ<Esc>", "j", ".", "u"], "# U\n\naZ\nefgh\nijkl\nmnop\n"],
    // An arrow in insert mode starts a new step, as in Vim.
    ["an arrow inside", ["A", "x", "<Left>", "y", "<Esc>", "u"], "# U\n\nabcdx\nefgh\nijkl\nmnop\n"],
    // Each normal-mode change is its own step.
    ["x, x", ["x", "x", "u"], "# U\n\nacd\nefgh\nijkl\nmnop\n"],
  ] as const) {
    await app.writeFile("U.md", START);
    await app.open("U");
    await app.idle();
    await app.call("cursor", 3, 2);
    await app.keys("<Esc>");
    await slowly([...keys]);
    await app.idle();
    for (let i = 0; i < 20 && (await app.readFile("U.md")) !== after; i++) await app.page.waitForTimeout(250);
    assert.equal(await app.readFile("U.md"), after, name);
  }
});

browserTest(h, "in a list, Enter continuing it and Enter ending it are part of the change u takes back", { scenario: "empty" }, async (app) => {
  const START = "# L\n\n- one\n- two\n";
  for (const [name, keys] of [
    ["a bullet continued", ["A", "<CR>", "t", "h", "r", "e", "e", "<Esc>", "u"]],
    ["the list ended", ["A", "<CR>", "<CR>", "a", "f", "t", "e", "r", "<Esc>", "u"]],
  ] as const) {
    await app.writeFile("L.md", START);
    await app.open("L");
    await app.idle();
    await app.call("cursor", 4, 1);
    await app.keys("<Esc>");
    for (const k of keys) {
      await app.keys(k);
      await app.page.waitForTimeout(600);
    }
    await app.idle();
    for (let i = 0; i < 20 && (await app.readFile("L.md")) !== START; i++) await app.page.waitForTimeout(250);
    assert.equal(await app.readFile("L.md"), START, name);
  }
});

browserTest(h, "someone else's change arriving while you type isn't part of your undo step", { scenario: "empty" }, async (app) => {
  await app.writeFile("U.md", "# U\n\nabcd\nefgh\nijkl\nmnop\n");
  await app.open("U");
  await app.idle();
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>A");
  await app.keys("x");
  await app.idle();
  const { revision } = (await (await app.page.context().request.get(`${app.base}/api/file?path=U.md`)).json()) as { revision: number };
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "U.md", text: "# U\n\nabcdx\nefgh\nijkl\nMNOP\n", base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "MNOP" }).waitFor();
  await app.page.waitForTimeout(600);
  await app.keys("y<Esc>u");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("U.md")).startsWith("# U\n\nabcd\n"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("U.md"), "# U\n\nabcd\nefgh\nijkl\nMNOP\n", "yours went in one step; theirs stays");
  await app.keys("u");
  await app.idle();
  await app.page.waitForTimeout(500);
  assert.equal(await app.readFile("U.md"), "# U\n\nabcd\nefgh\nijkl\nMNOP\n", "and u has nothing of theirs to take back");
});

browserTest(h, "an earlier change undone and redone in insert mode isn't taken back by the u for the typing after it", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nalpha\nbeta\ngamma\n");
  await app.goto({}, "Plan");
  await app.idle();
  const saved = async (has: (text: string) => boolean) => {
    await app.idle();
    for (let i = 0; i < 30 && !has(await app.readFile("Plan.md")); i++) await app.page.waitForTimeout(200);
    return app.readFile("Plan.md");
  };
  await app.call("cursor", 3, 1);
  await app.keys("A P<Esc>");
  assert.equal(await saved((t) => t.includes("alpha P")), "# Plan\n\nalpha P\nbeta\ngamma\n");
  await app.call("cursor", 4, 1);
  await app.keys("A");
  await app.keys("<Mod-z>");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: /^alpha$/ }).waitFor();
  await app.keys("<Mod-S-z>");
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "alpha P" }).waitFor();
  await app.keys(" x");
  await app.page.waitForTimeout(700);
  await app.keys(" y<Esc>");
  // The redo put the cursor back by the P, so that's where the typing goes.
  assert.equal(await saved((t) => t.includes(" y")), "# Plan\n\nalpha  x yP\nbeta\ngamma\n");
  await app.keys("u");
  assert.equal(await saved((t) => !t.includes(" y")), "# Plan\n\nalpha P\nbeta\ngamma\n", "one u takes back the typing only");
});
