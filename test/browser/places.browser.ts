// Places on wide screens (study step 10): the sidebar, the list beside the note, ⌘B, the go keys,
// saved searches and pinned notes. Under 840px the phone shell has Places (shell.browser.ts).
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const sections = (page: Page) => page.locator("#places section").evaluateAll((els) => els.map((s) => [s.querySelector("h3")?.textContent ?? "", [...s.querySelectorAll(".place-title")].map((t) => t.textContent)]));
const item = (page: Page, title: string) => page.locator("#places button.place-item", { has: page.locator(".place-title", { hasText: new RegExp(`^${title}$`) }) });
/** A place's row in Places, with its count and its × beside it. */
const row = (page: Page, title: string) => page.locator("#places li", { has: page.locator(".place-title", { hasText: new RegExp(`^${title}$`) }) });
const current = (page: Page) => page.locator("#places [aria-current]").locator(".place-title").allTextContents();

browserTest(h, "on a wide screen Places is a sidebar beside the list and the note: places open in the window, ⌘B hides it, and g then a key goes", { scenario: "preview", open: "Welcome" }, async (app) => {
  const { page } = app;
  await page.locator("#places .place-item").first().waitFor();
  const [top, bottom] = [(await sections(page))[0], (await sections(page)).at(-1)!];
  assert.deepEqual(top[1].slice(0, 3), ["Feed", "Search", "Today"]);
  assert.ok(top[1].includes("Tasks") && top[1].includes("Calendar"), JSON.stringify(top));
  assert.deepEqual(bottom[1], ["Sources", "Archive", "Trash", "Extensions", "Settings"]);
  // The Feed is the list beside the note (decision 4): a card opens its note in the window, and the Feed stays.
  await page.locator("#notes .list-feed .feed-card").first().waitFor();
  await app.listItem("Chores.md").click();
  await page.waitForFunction(() => document.title.startsWith("Chores"));
  assert.equal(await page.locator("#notes .list-feed").isVisible(), true);
  // A view place opens in the window, and is marked; beside it, every note.
  await item(page, "Tasks").click();
  await app.tabs.tab(0, "Tasks").waitFor();
  assert.deepEqual(await current(page), ["Tasks"]);
  assert.equal(await page.locator("#notes .list-head h2").textContent(), "All notes");
  // The go keys, outside text.
  await page.locator("#notes .list-head").click();
  await page.keyboard.press("g");
  await page.keyboard.press("x");
  await app.tabs.tab(0, "Trash").waitFor();
  assert.deepEqual(await current(page), ["Trash"]);
  // In a note, g is Vim's: g e moves back a word there, and doesn't go to Extensions.
  await app.open("Welcome");
  await app.editor.focus();
  await app.editor.keys("ge");
  assert.deepEqual(await current(page), ["Trash"], "g e in a note doesn't go anywhere");
  // ⌘B puts it away and brings it back, from outside the note (off a Mac, Ctrl-b in a note is Vim's page up).
  await page.locator("#notes .list-head").click();
  await page.keyboard.press("ControlOrMeta+b");
  await page.locator("#places").waitFor({ state: "hidden" });
  await page.keyboard.press("ControlOrMeta+b");
  await page.locator("#places").waitFor();
});

browserTest(h, "a search saved with ⌘S is a place, with how many notes it finds, and it lists them beside the note", { scenario: "preview", open: "Welcome" }, async (app) => {
  const { page } = app;
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#command-bar input").fill("tour");
  await page.locator("#command-bar li", { hasText: "Tasks tour" }).first().waitFor();
  await page.keyboard.press("ControlOrMeta+s");
  await page.locator(".dialog input").fill("Tour notes");
  await page.keyboard.press("Enter");
  await item(page, "Tour notes").waitFor();
  assert.deepEqual(await current(page), ["Tour notes"]);
  await row(page, "Tour notes").locator(".place-count", { hasText: /^\d+$/ }).waitFor();
  assert.deepEqual([await page.locator("#notes .list-head h2").textContent(), await page.locator("#notes .list-head code").textContent()], ["Tour notes", "tour"]);
  await app.listItem("Tasks tour.md").click();
  await page.waitForFunction(() => document.title.startsWith("Tasks tour"));
  assert.equal(JSON.parse(await app.readFile(".common-ink/places.json")).saved["Tour notes"], "tour");
  // The Feed takes the list back; removing the search takes it out of places.json.
  await item(page, "Feed").click();
  await page.locator("#notes .list-feed .feed-card").first().waitFor();
  assert.equal(await page.locator("#notes .list-head").isVisible(), false);
  await item(page, "Tour notes").hover();
  await row(page, "Tour notes").locator(".place-remove").click();
  await item(page, "Tour notes").waitFor({ state: "detached" });
  await page.waitForFunction(async () => !("Tour notes" in JSON.parse((await (await fetch("/api/file?path=.common-ink/places.json")).json()).text).saved));
});

browserTest(h, "pinned notes are in Places, in pin order, and open from there", { scenario: "preview", open: "Welcome" }, async (app) => {
  const { page } = app;
  await app.writeFile(".common-ink/pins.json", JSON.stringify({ pinned: ["Reading list.md", "Daily plan.md"] }));
  // The Preview pins Daily plan, then Reading list: this file turns them round.
  await page.waitForFunction(() => [...document.querySelectorAll("#places section")].find((s) => s.querySelector("h3")?.textContent === "Pinned")?.textContent === "PinnedReading listDaily plan");
  assert.deepEqual((await sections(page)).find(([h]) => h === "Pinned")?.[1], ["Reading list", "Daily plan"]);
  await item(page, "Daily plan").click();
  await page.waitForFunction(() => document.title.startsWith("Daily plan"));
  assert.deepEqual(await current(page), ["Daily plan"]);
});

browserTest(h, "on a phone there's no sidebar: Places stays the sheet, and ⌘B does nothing", { scenario: "preview", device: "phone" }, async (app) => {
  const { page } = app;
  await page.locator("#shell-bar").waitFor();
  assert.equal(await page.locator("#places").isVisible(), false);
  await page.keyboard.press("ControlOrMeta+b");
  assert.equal(await page.locator("#places").isVisible(), false);
});

browserTest(h, "offline, two searches saved one after the other both reach places.json once back", { scenario: "preview", open: "Welcome", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] }, async (app) => {
  const { page } = app;
  await page.locator("#places .place-item").first().waitFor();
  await page.context().setOffline(true);
  for (const [query, name] of [["garden", "Garden"], ["launch", "Launch"]]) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator("#command-bar input").fill(query);
    await page.keyboard.press("ControlOrMeta+s");
    await page.locator(".dialog input").fill(name);
    await page.keyboard.press("Enter");
    await item(page, name).waitFor();
  }
  // Both are held here, in the one edit waiting to be sent for places.json.
  await page.waitForFunction(
    () =>
      new Promise((done) => {
        const open = indexedDB.open("common-ink");
        open.onsuccess = () => {
          const all = open.result.transaction("unsent").objectStore("unsent").getAll();
          all.onsuccess = () => done((all.result as Array<{ path: string; text: string }>).some((u) => u.path === ".common-ink/places.json" && u.text.includes('"Garden"') && u.text.includes('"Launch"')));
        };
        open.onerror = () => done(false);
      }),
    undefined,
    { timeout: 10_000 },
  );
  await page.context().setOffline(false);
  await page.waitForFunction(async () => {
    const saved = JSON.parse((await (await fetch("/api/file?path=.common-ink/places.json")).json()).text).saved ?? {};
    return saved.Garden === "garden" && saved.Launch === "launch" && saved.Tours === "tour";
  }, undefined, { timeout: 20_000 });
});

browserTest(h, "a Feed card beside the note is a list row: ⌘-click opens it in a tab of its own, and a double click keeps its tab", { scenario: "preview", open: "Welcome" }, async (app) => {
  const { page } = app;
  await app.listItem("Chores.md").waitFor();
  assert.equal(await app.listItem("Chores.md").evaluate((el) => el.closest(".feed-card") !== null), true, "it's a Feed card");
  await app.listItem("Chores.md").click({ modifiers: ["ControlOrMeta"] });
  await app.tabs.tab(0, "Chores").waitFor();
  assert.ok((await app.tabs.windows())[0].tabs.some((t) => t.label === "Welcome"), "Welcome's tab stays");
  await app.listItem("Shopping.md").dblclick();
  await page.waitForFunction(() => document.title.startsWith("Shopping"));
  const shopping = (await app.tabs.windows())[0].tabs.find((t) => t.label === "Shopping");
  assert.equal(shopping?.preview ?? false, false, "kept, not the preview tab");
});
