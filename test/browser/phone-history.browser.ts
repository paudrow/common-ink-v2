// The phone shell's history after a few set moves (phone-history.ts says the rule). The random walks over
// it are in phone-walk-*.browser.ts, a few seeds to a file so they run side by side.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";
import { agrees, backs, inApp, look, settle, tap } from "./phone-history.ts";

const h = harness();

const title = (app: App) => app.page.locator("#shell-top h1").innerText();

/** ⋯ › Add label on a note shows History in the window, over the Feed. */
async function historyOverNote(app: App) {
  await tap(app, '#shell-bar [aria-label="Feed"]');
  await tap(app, '#notes a:text("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  await tap(app, '#shell-top [aria-label="More"]');
  await app.page.locator(".shell-sheet .shell-action", { hasText: "Add label" }).tap();
  await app.page.waitForTimeout(300);
  await app.page.keyboard.press("Escape");
  await settle(app);
  return agrees(app, "Add label");
}

browserTest(h, "back to a view shown over a place shows that view, and back goes on past it and out", { scenario: "lists", device: "phone" }, async (app) => {
  const over = await historyOverNote(app);
  assert.match(over.show, /^view:/);
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: /^Settings$/ }).last().tap();
  await settle(app);
  const length = (await look(app)).length;
  await app.page.goBack();
  await settle(app);
  const back = await agrees(app, "back to the view");
  assert.equal(back.show, over.show, "the view the entry says");
  assert.equal(back.length, length, "nothing pushed");
  const seen: string[] = [];
  for (let i = 0; i < 8 && inApp(app); i++) {
    await app.page.goBack();
    await settle(app);
    seen.push(inApp(app) ? (await agrees(app, `back ${i + 2}`)).show : "left");
  }
  assert.equal(seen.at(-1), "left", `back leaves the app at last: ${seen.join(" < ")}`);
});

browserTest(h, "a reload on a view shown over a place keeps it", { scenario: "lists", device: "phone" }, async (app) => {
  const before = await historyOverNote(app);
  const name = await title(app);
  await app.reload();
  await settle(app);
  const after = await agrees(app, "reload");
  assert.equal(after.show, before.show);
  assert.equal(await title(app), name);
  assert.equal(after.length, before.length);
});

for (const [gap, slow] of [[0, false], [150, false], [400, true]] as const) {
  browserTest(h, `three quick backs (${gap} ms apart${slow ? ", slow server" : ""}) land three entries back, and keep forward`, { scenario: "lists", device: "phone" }, async (app) => {
    await app.writeFile("Second.md", "# Second\n\nx\n");
    await app.writeFile("Third.md", "# Third\n\ny\n");
    await app.reload();
    for (const n of ["Lists tour", "Second", "Third"]) {
      await tap(app, '#shell-bar [aria-label="Feed"]');
      await settle(app);
      await tap(app, `#notes a:text("${n}")`);
      await settle(app);
      if (n !== "Third") {
        await tap(app, '#shell-bar [aria-label="Calendar"]');
        await settle(app);
      }
    }
    const before = (await agrees(app, "three notes")).length;
    await backs(app, 3, gap, slow);
    const after = await agrees(app, "three backs");
    assert.equal(after.length, before, "no entry pushed, forward history kept");
    assert.equal(await title(app), "Feed", "three backs from Third land on the Feed, as they do one at a time");
    // Forward is all there: three forwards come back to Third.
    for (let i = 0; i < 3; i++) await app.page.goForward();
    await app.page.waitForTimeout(slow ? 1000 : 600);
    await agrees(app, "three forwards");
    assert.equal(await title(app), "Third");
  });
}
