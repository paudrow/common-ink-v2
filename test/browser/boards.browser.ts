// Boards, from the Catalog, in a real browser against the real Worker: it asks before reading and before
// writing; its task lists gather todos from every note; and moving a Kanban card rewrites the note.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness } from "./harness.ts";

const h = harness();

const allow = async (page: Page, asking: RegExp) => {
  await page.waitForSelector(".dialog");
  assert.match((await page.textContent(".dialog"))!, asking);
  await page.click("text=Always allow");
};

const note = (page: Page, path: string): Promise<{ text: string; revision: number }> => page.evaluate((path) => fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => r.json()), path);

/** Wait until a note's text passes `test`, asking the server every quarter second. */
async function until(page: Page, path: string, test: (text: string) => boolean) {
  for (let tries = 0; tries < 60; tries++) {
    if (test((await note(page, path)).text)) return;
    await page.waitForTimeout(250);
  }
  assert.fail(`${path} never changed as expected:\n${(await note(page, path)).text}`);
}

test("task lists gather todos from the notes; checking one off and moving a card are Boards' changes in their notes", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${h.base}/?file=${encodeURIComponent("Boards tour.md")}`);
  await allow(page, /^Boards Catalog by Common Ink wants to\s*Read all your notes/);
  const tasks = page.frameLocator('.cm-embed[data-embed="tasks"] iframe').first();
  await tasks.locator("li").first().waitFor();
  const titles = await tasks.locator("li .title").allTextContents();
  assert.ok(titles.includes("Take out the recycling"), titles.join(" | "));

  // Check off a todo from Chores, there.
  await tasks.locator("li", { hasText: "Take out the recycling" }).locator("input").check();
  await allow(page, /^Boards Catalog by Common Ink wants to\s*Change the note Chores/);
  // It's recurring, so it stays open and moves on a week, in Chores.
  const today = new Date().toLocaleDateString("en-CA");
  await until(page, "Chores.md", (text) => {
    const due = /- \[ \] Take out the recycling due:(\d{4}-\d{2}-\d{2}) every:week/.exec(text)?.[1];
    return !!due && due > today;
  });

  // Move a card: it moves at once, and the board's markdown follows, with the same frame throughout.
  const board = page.frameLocator('.cm-embed[data-embed="kanban"] iframe');
  await board.locator(".card", { hasText: "Book the venue" }).waitFor();
  const frame = await (await page.$('.cm-embed[data-embed="kanban"] iframe'))!.contentFrame();
  await frame!.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
  await page.evaluate(() => ((window as unknown as { board: Element }).board = document.querySelector('.cm-embed[data-embed="kanban"] iframe')!));
  const sameFrame = async () =>
    (await page.evaluate(() => document.querySelector('.cm-embed[data-embed="kanban"] iframe') === (window as unknown as { board: Element }).board)) &&
    (await (await page.$('.cm-embed[data-embed="kanban"] iframe'))!.contentFrame())!.evaluate(() => (window as unknown as { mark?: number }).mark === 1);
  // Its → button (shown on hover or focus), pressed as a keyboard would.
  await board.locator(".card", { hasText: "Book the venue" }).locator("button", { hasText: "→" }).evaluate((b: HTMLElement) => b.click());
  await board.locator(".column", { hasText: "Doing" }).locator(".card", { hasText: "Book the venue" }).waitFor();
  await until(page, "Boards tour.md", (text) => text.includes("## Doing\n- Draft the slides\n  with speaker notes\n- Book the venue"));
  // The note's change has come back to the editor: still the same frame, never reloaded.
  await page.waitForTimeout(800);
  assert.equal(await sameFrame(), true, "no flash: the board's frame stays, across its own write-back");
  const history = await page.evaluate(() => fetch(`/api/history?path=${encodeURIComponent("Boards tour.md")}`).then((r) => r.json()));
  assert.ok((history.changes ?? history).some((c: { author: { kind: string; id?: string } }) => c.author.kind === "extension" && c.author.id === "boards"), "the move is Boards' change");
  assert.ok((await note(page, "Boards tour.md")).text.includes("## To do\n- Write the outline\n- Send the invitations"));
  assert.deepEqual(errors, []);
  await page.close();
});
