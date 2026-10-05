// A few key views as pictures, in light and dark, compared with their baselines (snapshots.ts): lists,
// todos, markdown extras, two windows side by side, and the Extensions view. Each is on a scenario
// with a fixed clock, so nothing in it changes from run to run.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { matchSnapshot } from "./snapshots.ts";

const h = harness();
const viewport = { width: 1000, height: 700 };

for (const dark of [false, true]) {
  const theme = dark ? "dark" : "light";

  browserTest(h, `the lists tour and Chores look as they did (${theme})`, { scenario: "todos", viewport, dark }, async (app) => {
    const problems: Array<string | null> = [];
    await app.open("Chores");
    await app.page.waitForSelector(".tab-editor:not([hidden]) .tk");
    await app.editor.at(1);
    await app.idle();
    problems.push(await matchSnapshot(app.page, `chores-${theme}`));
    await app.reset("lists");
    await app.goto({}, "Lists tour");
    await app.page.waitForSelector(".tab-editor:not([hidden]) .cm-list-bullet");
    await app.editor.at(1);
    await app.idle();
    problems.push(await matchSnapshot(app.page, `lists-${theme}`));
    assert.deepEqual(problems.filter(Boolean), []);
  });

  browserTest(h, `markdown extras and two windows side by side look as they did (${theme})`, { scenario: "embeds", viewport, dark, open: "Markdown extras" }, async (app) => {
    const problems: Array<string | null> = [];
    await app.page.waitForSelector(".cm-gfm-table table");
    await app.codeShown("Python");
    await app.page.waitForFunction(() => [...document.querySelectorAll(".cm-md-codeblock span")].some((s) => s.textContent === "def" && s.className));
    await app.editor.at(1);
    await app.page.evaluate(() => document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.scrollTo(0, 0));
    await app.idle();
    problems.push(await matchSnapshot(app.page, `markdown-${theme}`));
    await app.keys(":vs Embeds tour<CR>");
    await app.page.waitForFunction(() => document.querySelectorAll("section.group").length === 2);
    await app.page.locator(".cm-embed[data-embed=timer]").filter({ visible: true }).first().waitFor();
    await app.idle();
    problems.push(await matchSnapshot(app.page, `split-${theme}`));
    assert.deepEqual(problems.filter(Boolean), []);
  });

  browserTest(h, `the Extensions view looks as it did (${theme})`, { scenario: "extensions", viewport, dark }, async (app) => {
    const problems: Array<string | null> = [];
    await app.extensions.show();
    await app.page.waitForSelector('.extension-row[data-extension="word-count"]');
    await app.idle();
    problems.push(await matchSnapshot(app.page, `extensions-${theme}`));
    assert.deepEqual(problems.filter(Boolean), []);
  });
}
