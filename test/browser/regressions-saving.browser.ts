// Bugs people found by hand (regressions.browser.ts says more): an edit kept through closing its tab,
// moving it, a reload, leaving the page, and a beacon sent as the page went.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

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
