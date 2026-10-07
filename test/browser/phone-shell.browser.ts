// The phone shell (web/src/shell.ts), by touch at 375 × 812: the bottom bar, the Places sheet, a note
// over its place with back, the sheets for views about the note and its menu, and the keyboard toolbar.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const bar = (app: App) => app.page.evaluate(() => [...document.querySelectorAll("#shell-bar button")].map((b) => b.getAttribute("aria-label")));
const title = (app: App) => app.page.locator("#shell-top h1").innerText();
const tap = (app: App, selector: string) => app.page.locator(selector).first().tap();
const closeSheet = (app: App) => app.page.evaluate(() => document.querySelector(".modal-scrim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

/** Open a note from its card in the Feed, where the app opens on a phone. */
async function openCard(app: App, title: string) {
  await app.page.locator(`.feed-card-title:text-is("${title}")`).first().tap();
  await app.page.locator("#shell-top h1", { hasText: title }).waitFor();
}

browserTest(h, "on a phone, the bottom bar goes to places, a note opens over the Feed, and back comes up to it", { scenario: "lists", device: "phone" }, async (app) => {
  assert.deepEqual(await bar(app), ["Feed", "Today", "Calendar", "Search", "Places"]);
  await tap(app, '#shell-bar [aria-label="Feed"]');
  assert.equal(await title(app), "Feed");
  await app.page.locator(".feed-card").first().waitFor();
  assert.equal(await app.page.locator("#workbench .cm-editor").isVisible(), false, "one screen at a time");
  await tap(app, '.feed-card-title:text-is("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  assert.equal(await app.page.locator(".feed").isVisible(), false);
  assert.equal(await app.page.evaluate(() => document.activeElement?.closest(".cm-editor") ?? null), null, "opened to read: no on-screen keyboard");

  // The system's back gesture goes back to the list.
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  await tap(app, '.feed-card-title:text-is("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  // And so does the top bar's back.
  await tap(app, '#shell-top [aria-label="Back to Feed"]');
  assert.equal(await title(app), "Feed");

  await tap(app, '#shell-bar [aria-label="Calendar"]');
  await app.page.locator("#workbench .cal-page").first().waitFor();
  assert.equal(await title(app), "Calendar");
  assert.equal(await app.page.locator('#shell-top [aria-label^="Back"]').count(), 0, "a place has nowhere to go back up to");
  assert.equal(await app.page.locator('#shell-bar [aria-current="page"]').getAttribute("aria-label"), "Calendar");
});

browserTest(h, "the Places sheet lists what there is, and the bottom bar's places can be changed", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Places"]');
  const places = await app.page.locator(".shell-sheet .shell-place").allInnerTexts();
  // Each extension's place says whose it is, under its name.
  // Each extension's place says whose it is, under its name, unless that's its name too.
  assert.deepEqual(places, ["Feed", "Today\nDaily notes", "Tasks", "Calendar", "Contacts", "Sources\nData sources", "Uploads", "Archive", "Trash", "Extensions", "Settings", "Customize the bottom bar…"]);
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
  await app.page.locator(".shell-sheet label", { hasText: "Calendar" }).locator("input").uncheck();
  await app.page.locator(".shell-sheet label", { hasText: "Tasks" }).locator("input").check();
  await app.page.locator(".shell-sheet .shell-primary").tap();
  await app.page.waitForFunction(() => !document.querySelector(".shell-sheet"));
  assert.deepEqual(await bar(app), ["Feed", "Today", "Tasks", "Search", "Places"]);
  await app.idle();
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/places.json")), { bar: ["feed", "daily.today", "tasks.tasks"] });

  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Settings" }).tap();
  await app.page.locator(".settings-editor").waitFor();
  assert.equal(await title(app), "Settings");
});

browserTest(h, "a note's ◷ sheet shows its history, and ⋯ greys what needs a wider screen, with why", { scenario: "lists", device: "phone" }, async (app) => {
  // The app opens on the Feed: the note is a card there.
  await openCard(app, "Lists tour");
  await tap(app, '#shell-top [aria-label="History and views about this note"]');
  await app.page.locator(".shell-sheet .shell-switcher", { hasText: "History" }).waitFor();
  await app.page.locator(".shell-sheet .shell-context .change").first().waitFor();
  await closeSheet(app);
  await tap(app, '#shell-top [aria-label="More"]');
  const split = app.page.locator(".shell-sheet .shell-action", { hasText: "split to the right" });
  assert.equal(await split.getAttribute("aria-disabled"), "true");
  assert.match(await split.innerText(), /needs a screen 840px wide/);
});

browserTest(h, "tapping a note edits it, the keyboard toolbar takes the bottom bar's place, and its buttons edit the line", { scenario: "lists", device: "phone" }, async (app) => {
  // The app opens on the Feed: the note is a card there.
  await openCard(app, "Lists tour");
  await app.page.locator(".cm-line", { hasText: "Basil" }).tap();
  await app.page.locator("#shell-toolbar").waitFor();
  assert.equal(await app.page.locator("#shell-bar").isVisible(), false);
  await app.page.locator('#shell-toolbar [aria-label="Make this line a task"]').tap();
  await app.page.locator('#shell-toolbar [aria-label="Add a due date"]').tap();
  assert.equal((await app.editor.cursor())?.text, "    - [ ] Basil due:");
  await app.page.locator('#shell-toolbar [aria-label="Indent"]').tap();
  assert.equal((await app.editor.cursor())?.text, "      - [ ] Basil due:", "Lists' indent, as a button");
  await app.page.locator('#shell-toolbar [aria-label="Hide the keyboard"]').tap();
  await app.page.locator("#shell-bar").waitFor();
  assert.equal(await app.page.locator("#shell-toolbar").isVisible(), false);
});

browserTest(h, "on a laptop there's no shell: the notes list, tabs and status bar as before", { scenario: "lists" }, async (app) => {
  assert.equal(await app.page.locator("#shell-bar").isVisible(), false);
  assert.equal(await app.page.locator("#shell-top").isVisible(), false);
  assert.equal(await app.page.locator("#notes").isVisible(), true);
});

// The verifier's cases for #161: history that doesn't pile up, a core place no extension can take, and the bar offline.
const len = (app: App) => app.page.evaluate(() => history.length);

browserTest(h, "F1 re-tapping the place you're on, and ‹ back, don't pile up history entries", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Feed"]');
  const start = await len(app);
  for (let i = 0; i < 3; i++) await tap(app, '#shell-bar [aria-label="Feed"]');
  assert.equal(await len(app), start, "tapping Feed while on Feed adds no entries");
  await tap(app, '.feed-card-title:text-is("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  await tap(app, '#shell-top [aria-label="Back to Feed"]');
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  // System back after ‹ shouldn't land on the note again: the Feed is the first entry, so back leaves the app.
  await app.page.goBack();
  await app.page.waitForTimeout(300);
  const left = !app.page.url().startsWith(app.base);
  assert.ok(left || (await app.page.locator("#shell-top h1").innerText()) !== "Lists tour", "back after ‹ goes behind the Feed, not into the note again");
  assert.ok(left, "and the Feed was the app's first entry");
});

browserTest(h, "F2 a sandboxed extension's place can't take over the core's Settings row", { scenario: "lists", device: "phone", allowErrors: [/./] }, async (app) => {
  await app.writeFile(
    ".common-ink/extensions/spoof/extension.json",
    JSON.stringify({ name: "Spoof", version: "1.0.0", activationEvents: ["onStartup"], contributes: { views: { sidebar: [{ id: "spoof.view", name: "Spoof view" }] }, places: [{ id: "settings", title: "Settings", icon: "settings", view: "spoof.view" }] } }),
  );
  await app.writeFile(".common-ink/extensions/spoof/index.js", `export default { activate() {} };`);
  await app.reload();
  await app.idle();
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: /^Settings$/ }).last().tap();
  await app.page.waitForTimeout(1000);
  assert.equal(await app.page.locator(".settings-editor").count(), 1, "the core's Settings row opens the settings editor");
  await tap(app, '#shell-bar [aria-label="Places"]');
  assert.deepEqual(await app.page.locator(".shell-sheet .shell-place", { hasText: /^Settings/ }).allInnerTexts(), ["Settings\nSpoof · workspace extension", "Settings"], "the extension's says whose it is");
});

// The browser says so for each request it can't send offline; anything else the page logs fails the test.
browserTest(h, "F3 Done in Customize the bottom bar, offline, says why and logs no error", { scenario: "lists", device: "phone", allowErrors: [/net::ERR_INTERNET_DISCONNECTED/] }, async (app) => {
  await app.page.context().setOffline(true);
  await app.page.waitForTimeout(500);
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
  await app.page.locator(".shell-sheet label", { hasText: "Calendar" }).locator("input").uncheck();
  await app.page.locator(".shell-sheet label", { hasText: "Tasks" }).locator("input").check();
  await app.page.locator(".shell-sheet .shell-primary").tap();
  await app.page.waitForTimeout(1500);
  await app.page.context().setOffline(false);
  // Changed here, and said why it isn't saved yet; the page logs no error, and the change is sent once back.
  assert.deepEqual(await bar(app), ["Feed", "Today", "Tasks", "Search", "Places"]);
  assert.ok((await app.state()).notices.some((n) => n.startsWith("You're offline: the bottom bar is changed here")));
  await app.page.waitForFunction(
    () => fetch("/api/file?path=.common-ink%2Fplaces.json").then((r) => r.json()).then((f: { text: string }) => f.text.includes("tasks.tasks")),
    null,
    { timeout: 20_000, polling: 1000 },
  );
});

browserTest(h, "opening a note from a place and coming back up, four times, leaves one entry for the note", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Feed"]');
  const start = await len(app);
  for (let i = 0; i < 4; i++) {
    await tap(app, '.feed-card-title:text-is("Lists tour")');
    await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
    await tap(app, '#shell-top [aria-label="Back to Feed"]');
    await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  }
  assert.ok((await len(app)) <= start + 1, `${(await len(app)) - start} entries more than the Feed's`);
  // Forward goes to the note again, and back from it to the Feed.
  await app.page.goForward();
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
});

browserTest(h, "F4 a bar id that isn't a place now (old id, or an extension turned off) doesn't block Customize", { scenario: "lists", device: "phone" }, async (app) => {
  await app.writeFile(".common-ink/places.json", JSON.stringify({ bar: ["feed", "today", "calendar"] }, null, 2) + "\n");
  await app.reload();
  await app.idle();
  const shown = await app.page.evaluate(() => [...document.querySelectorAll("#shell-bar button")].map((b) => b.getAttribute("aria-label")));
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
  // The old ids are read as the new: the bar shows all three, so Tasks can be ticked once one is let go.
  assert.deepEqual(shown, ["Feed", "Today", "Calendar", "Search", "Places"]);
  const tasks = app.page.locator(".shell-sheet label", { hasText: "Tasks" }).locator("input");
  await app.page.locator(".shell-sheet label", { hasText: "Calendar" }).locator("input").uncheck();
  assert.equal(await tasks.isDisabled(), false, `with the bar showing ${JSON.stringify(shown)}, Tasks can be ticked`);
});

browserTest(h, "F5 after a view place, opening the note you had open gets its own entry: back goes to the Feed, a reload keeps the note", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Calendar"]');
  await app.page.locator("#workbench .cal-page").first().waitFor();
  await tap(app, '#shell-bar [aria-label="Feed"]');
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  const before = await len(app);
  await tap(app, '.feed-card-title:text-is("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  await app.page.waitForTimeout(600);
  assert.equal(await len(app), before + 1, "the note has an entry of its own");
  await app.reload();
  await app.page.waitForTimeout(800);
  assert.equal(await app.page.locator("#shell-top h1").innerText(), "Lists tour", "a reload keeps the note on show");
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor({ timeout: 3000 });
});

browserTest(h, "an extension turned off frees its slot on the bar, and its id stays in places.json after the three", { scenario: "lists", device: "phone" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "extensions.disabled": ["calendar"] }));
  await app.reload();
  await app.idle();
  assert.deepEqual(await bar(app), ["Feed", "Today", "Search", "Places"]);
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
  await app.page.locator(".shell-sheet label", { hasText: "Tasks" }).locator("input").check();
  await app.page.locator(".shell-sheet .shell-primary").tap();
  await app.idle();
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/places.json")).bar, ["feed", "daily.today", "tasks.tasks", "calendar.calendar"], "Calendar's id kept, after the three");
  assert.deepEqual(await bar(app), ["Feed", "Today", "Tasks", "Search", "Places"]);
});

for (const place of ["Feed", "Calendar"]) {
  browserTest(h, `G1 a reload on ${place} stays on ${place}, and adds no entry`, { scenario: "lists", device: "phone" }, async (app) => {
    await tap(app, `#shell-bar [aria-label="${place}"]`);
    await app.page.locator("#shell-top h1", { hasText: place }).waitFor();
    const before = await len(app);
    await app.reload();
    await app.page.waitForTimeout(800);
    assert.equal(await title(app), place);
    assert.equal(await len(app), before);
  });
}

browserTest(h, "G2 Today, Feed, Today again: Today's note is a step over the Feed, so back comes to the Feed", { scenario: "lists", device: "phone" }, async (app) => {
  for (const p of ["Today", "Feed", "Today"]) {
    await tap(app, `#shell-bar [aria-label="${p}"]`);
    await app.page.waitForTimeout(700);
  }
  assert.match(await title(app), /^Journal\//);
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor({ timeout: 3000 });
});

browserTest(h, "G3 an extension's place can't pass for Settings with a look-alike title", { scenario: "lists", device: "phone", allowErrors: [/./] }, async (app) => {
  const titles = ["Ѕettings", "Set​tings", "Ｓettings", "Settings."];
  await app.writeFile(
    ".common-ink/extensions/spoof/extension.json",
    JSON.stringify({ name: "Spoof", version: "1.0.0", activationEvents: ["onStartup"], contributes: { views: { sidebar: [{ id: "spoof.view", name: "Spoof view" }] }, places: titles.map((t, i) => ({ id: `p${i}`, title: t, icon: "settings", view: "spoof.view" })) } }),
  );
  await app.writeFile(".common-ink/extensions/spoof/index.js", `export default { activate() {} };`);
  await app.reload();
  await app.idle();
  await tap(app, '#shell-bar [aria-label="Places"]');
  const rows = await app.page.locator(".shell-sheet .shell-place").allInnerTexts();
  for (const t of titles) assert.ok(rows.some((r) => r.startsWith(t) && r.includes("Spoof")), `"${JSON.stringify(t)}" says whose it is: ${JSON.stringify(rows)}`);
});

browserTest(h, "an extension's place on the bar says whose it is when held", { scenario: "lists", device: "phone" }, async (app) => {
  const today = app.page.locator('#shell-bar [aria-label="Today"]');
  assert.equal(await today.getAttribute("title"), "Today · Daily notes");
  const box = (await today.boundingBox())!;
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.waitForTimeout(700);
  await app.page.mouse.up();
  assert.ok((await app.state()).notices.includes("Today comes from Daily notes."));
  assert.notEqual(await title(app), "Journal/2026-10-05", "a long press isn't a tap");
  // The next tap is a tap.
  await today.tap();
  await app.page.locator("#shell-top h1", { hasText: /^Journal\// }).waitFor({ timeout: 3000 });
});

browserTest(h, "a slow drag across a bar button isn't a long press, and the tap after it still goes", { scenario: "lists", device: "phone" }, async (app) => {
  const calendar = app.page.locator('#shell-bar [aria-label="Calendar"]');
  const box = (await calendar.boundingBox())!;
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 });
  await app.page.waitForTimeout(700);
  await app.page.mouse.up();
  assert.ok(!(await app.state()).notices.some((n) => n.includes("comes from")), "no long press");
  await calendar.tap();
  await app.page.locator("#shell-top h1", { hasText: "Calendar" }).waitFor({ timeout: 3000 });
});

browserTest(h, "a reload on Settings, a place from the Places sheet, stays on Settings, and adds no entry", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Places"]');
  await app.page.locator(".shell-sheet .shell-place", { hasText: /^Settings$/ }).tap();
  await app.page.locator(".settings-editor").waitFor();
  const before = await len(app);
  await app.reload();
  await app.page.locator(".settings-editor").waitFor();
  assert.equal(await title(app), "Settings");
  assert.equal(await len(app), before);
});

browserTest(h, "H1 Today, Calendar, Today again: Today's note is a step over Calendar, and a reload keeps it", { scenario: "lists", device: "phone" }, async (app) => {
  for (const p of ["Today", "Calendar", "Today"]) {
    await tap(app, `#shell-bar [aria-label="${p}"]`);
    await app.page.waitForTimeout(800);
  }
  assert.match(await title(app), /^Journal\//);
  await app.reload();
  await app.page.waitForTimeout(900);
  assert.match(await title(app), /^Journal\//, "a reload keeps Today's note");
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Calendar" }).waitFor({ timeout: 3000 });
});

browserTest(h, "H2 after a reload on the Feed, a note opened and ‹ back leave no second Feed entry", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Feed"]');
  await app.reload();
  await app.page.waitForTimeout(900);
  await tap(app, '.feed-card-title:text-is("Lists tour")');
  await app.page.locator("#shell-top h1", { hasText: "Lists tour" }).waitFor();
  await tap(app, '#shell-top [aria-label="Back to Feed"]');
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  await app.page.goBack();
  await app.page.waitForTimeout(500);
  assert.ok(!app.page.url().startsWith(app.base) || (await title(app)) !== "Feed", "back from the Feed doesn't show the Feed again");
});

browserTest(h, "H3 Search on a phone, picking the note that was open, shows it over the place", { scenario: "lists", device: "phone" }, async (app) => {
  await tap(app, '#shell-bar [aria-label="Feed"]');
  const before = await len(app);
  await tap(app, '#shell-bar [aria-label="Search"]');
  await app.page.locator("#command-bar:not([hidden]) input").waitFor();
  await app.page.keyboard.insertText("Basil");
  await app.page.locator("#command-bar li", { hasText: "Lists tour" }).first().waitFor();
  await app.page.locator("#command-bar li", { hasText: "Lists tour" }).first().tap();
  await app.page.waitForTimeout(800);
  assert.equal(await title(app), "Lists tour");
  // The Feed was reached by going back to its entry, so the note's old entry ahead of it is replaced, not added to.
  assert.ok((await len(app)) <= before + 1);
  assert.deepEqual(await app.page.evaluate(() => (history.state as { place: string; show: string }) && { place: history.state.place, show: history.state.show }), { place: "feed", show: "file:Lists tour.md" }, "the entry says what's on show");
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor({ timeout: 3000 });
});

browserTest(h, "a sandboxed extension's places and toolbar buttons run only its own commands: ones naming the app's or another extension's never go in", { scenario: "lists", device: "phone" }, async (app) => {
  const device = ".common-ink/users/tester@localhost/devices/lever-phone/device.json";
  const choices = async () => (({ keyboard, extensions }) => ({ keyboard, extensions }))(JSON.parse(await app.readFile(device)));
  const before = await choices();
  await app.writeFile(
    ".common-ink/extensions/sneaky/extension.json",
    JSON.stringify({
      id: "sneaky",
      name: "Sneaky",
      version: "1.0.0",
      description: "test",
      main: "index.js",
      files: ["index.js"],
      activationEvents: ["onStartup"],
      permissions: {},
      contributes: {
        commands: [{ command: "sneaky.hello", title: "Hello" }],
        statusBarItems: [{ id: "sneaky.said", alignment: "left" }],
        places: [
          { id: "app", title: "Go app", command: "vim.onHere" },
          { id: "other", title: "Go other", command: "lists.indent" },
          { id: "own", title: "Go own", command: "sneaky.hello" },
        ],
        toolbar: [
          { command: "device.keyboardYes", title: "Sneak app", label: "A" },
          { command: "lists.indent", title: "Sneak other", label: "O" },
          { command: "sneaky.hello", title: "Sneak own", label: "S" },
        ],
      },
    }),
  );
  await app.writeFile(
    ".common-ink/extensions/sneaky/index.js",
    'export default { activate(ctx) { let n = 0; ctx.commands.register("sneaky.hello", () => ctx.statusBar.set("sneaky.said", `hello ${++n}`)); } };\n',
  );
  await app.reload();
  await app.page.waitForFunction(() => (window as unknown as { __commonInk: { state(): Promise<{ extensions: Array<{ id: string; state: string }> }> } }).__commonInk.state().then((s) => s.extensions.find((e) => e.id === "sneaky")?.state === "active"));
  const said = app.page.locator('[data-item="sneaky.said"]');

  await app.page.locator('#shell-bar [aria-label="Places"]').tap();
  const places = await app.page.locator(".shell-sheet .shell-place").allInnerTexts();
  assert.ok(places.some((t) => t.startsWith("Go own")), places.join(" | "));
  assert.ok(!places.some((t) => t.startsWith("Go app") || t.startsWith("Go other")), `only its own command's place: ${places.join(" | ")}`);
  await app.page.locator(".shell-sheet .shell-place", { hasText: /^Go own/ }).tap();
  await app.page.waitForFunction(() => document.querySelector('[data-item="sneaky.said"]')?.textContent === "hello 1");

  await app.open("Lists tour");
  await app.page.locator(".cm-line", { hasText: "Basil" }).tap();
  await app.page.locator("#shell-toolbar").waitFor();
  assert.equal(await app.page.locator('#shell-toolbar [aria-label="Sneak app"], #shell-toolbar [aria-label="Sneak other"]').count(), 0, "only its own command's button");
  await app.page.locator('#shell-toolbar [aria-label="Sneak own"]').tap();
  await app.page.waitForFunction(() => document.querySelector('[data-item="sneaky.said"]')?.textContent === "hello 2");
  assert.equal(await said.count(), 1);

  await app.idle();
  assert.equal(await app.page.locator(".notice", { hasText: "an extension asked" }).count(), 0, "nothing ran for it to refuse");
  assert.equal((await app.extensions.state("vim"))?.state, "unmet");
  assert.deepEqual(await choices(), before, "the device file keeps your choices");
});

browserTest(h, "the bottom bar says how tall it is, for the not-saved pill to float above, and the keyboard toolbar does in its place", { scenario: "lists", device: "phone" }, async (app) => {
  // The app opens on the Feed: the note is a card there.
  await openCard(app, "Lists tour");
  const said = () => app.page.evaluate(() => document.documentElement.style.getPropertyValue("--not-saved-bottom"));
  const bar = await app.page.locator("#shell-bar").evaluate((e) => Math.round((e as HTMLElement).offsetHeight - parseFloat(getComputedStyle(e).paddingBottom)));
  assert.ok(bar > 0);
  assert.equal(await said(), `${bar}px`);
  await app.page.locator(".cm-line", { hasText: "Basil" }).tap();
  await app.page.locator("#shell-toolbar").waitFor();
  const toolbar = await app.page.locator("#shell-toolbar").evaluate((e) => (e as HTMLElement).offsetHeight);
  await app.page.waitForFunction((h) => document.documentElement.style.getPropertyValue("--not-saved-bottom") === `${h}px`, toolbar);
});

/** A trusted extension with a view, and a sandboxed lookalike under the same name whose place and ◷ sheet entry name that view. */
async function lookalike(app: App) {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["wordCount"]\n}\n');
  await app.writeFile(
    ".common-ink/extensions/wordCount/extension.json",
    JSON.stringify({ name: "Word count", activationEvents: ["onStartup"], contributes: { views: { sidebar: [{ id: "wordCount", name: "Counts" }] } } }),
  );
  await app.writeFile(".common-ink/extensions/wordCount/index.js", 'export default { activate(ctx) { ctx.views.register("wordCount", { render(el) { el.textContent = "TRUSTED VIEW"; } }); } };\n');
  await app.writeFile(
    ".common-ink/extensions/word-count/extension.json",
    JSON.stringify({
      name: "Lookalike",
      activationEvents: ["onStartup"],
      contributes: { places: [{ id: "p", title: "Bank", view: "wordCount" }, { id: "q", title: "Dotted", view: "word-count.nothere" }], views: { context: [{ id: "wordCount", name: "Bank sheet" }] } },
    }),
  );
  await app.writeFile(".common-ink/extensions/word-count/index.js", "export default { activate() {} };\n");
  await app.reload();
  await app.idle();
}

browserTest(h, "a sandboxed extension's place can't open a view under its name that's another extension's", { scenario: "lists", device: "phone" }, async (app) => {
  await lookalike(app);
  await app.page.locator('#shell-bar [aria-label="Places"]').tap();
  const rows = await app.page.locator(".shell-sheet .shell-place").allInnerTexts();
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((r) => r.startsWith("Bank") || r.startsWith("Dotted")), `no place for a view it doesn't own or declare: ${JSON.stringify(rows)}`);
});

browserTest(h, "a sandboxed extension's ◷ sheet entry can't show a view under its name that's another extension's", { scenario: "lists", device: "phone" }, async (app) => {
  await lookalike(app);
  await app.open("Lists tour");
  await app.page.locator('#shell-top [aria-label="History and views about this note"]').tap();
  const views = await app.page.locator(".shell-sheet .shell-switcher [role=tab]").allInnerTexts();
  assert.ok(views.length > 0 && !views.includes("Bank sheet"), `only views their extensions own: ${JSON.stringify(views)}`);
  assert.equal(await app.page.getByText("TRUSTED VIEW").count(), 0);
});
