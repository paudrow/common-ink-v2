// A few key views as pictures, in light and dark, compared with their baselines (snapshots.ts): lists,
// todos, markdown extras, two windows side by side, and the Extensions view. Each is on a scenario
// with a fixed clock, so nothing in it changes from run to run.
import { browserTest, harness } from "./harness.ts";
import { matchSnapshot } from "./snapshots.ts";

const h = harness();
const viewport = { width: 1000, height: 700 };

for (const dark of [false, true]) {
  const theme = dark ? "dark" : "light";

  browserTest(h, `the lists tour and Chores look as they did (${theme})`, { scenario: "todos", viewport, dark }, async (app) => {
    await app.open("Chores");
    await app.page.waitForSelector(".tab-editor:not([hidden]) .todo-chip");
    await app.editor.at(1);
    await app.idle();
    await matchSnapshot(app.page, `chores-${theme}`);
    await app.reset("lists");
    await app.goto({}, "Lists tour");
    await app.page.waitForSelector(".tab-editor:not([hidden]) .cm-list-bullet");
    await app.editor.at(1);
    await app.idle();
    await matchSnapshot(app.page, `lists-${theme}`);
  });

  browserTest(h, `markdown extras and two windows side by side look as they did (${theme})`, { scenario: "embeds", viewport, dark, open: "Markdown extras" }, async (app) => {
    await app.page.waitForSelector(".cm-gfm-table table");
    await app.page.waitForFunction(() => [...document.querySelectorAll(".cm-md-codeblock span")].some((s) => s.textContent === "def" && s.className));
    await app.editor.at(1);
    await app.idle();
    await matchSnapshot(app.page, `markdown-${theme}`);
    await app.keys(":vs Embeds tour<CR>");
    await app.page.waitForFunction(() => document.querySelectorAll("section.group").length === 2);
    await app.page.locator(".cm-embed[data-embed=timer]").filter({ visible: true }).first().waitFor();
    await app.idle();
    await matchSnapshot(app.page, `split-${theme}`);
  });

  browserTest(h, `the Extensions view looks as it did (${theme})`, { scenario: "extensions", viewport, dark }, async (app) => {
    await app.extensions.show();
    await app.page.waitForSelector('.extension-row[data-extension="word-count"]');
    await app.idle();
    await matchSnapshot(app.page, `extensions-${theme}`);
  });
}
