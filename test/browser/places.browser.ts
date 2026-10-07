// Places on wide screens (study step 10): the sidebar, the list beside the note, ⌘B, the go keys,
// saved searches and pinned notes. Under 840px the phone shell has Places (shell.browser.ts).
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

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
  // Beside the note, every note; the Feed opens in the window.
  assert.equal(await page.locator("#notes .list-head h2").textContent(), "All notes");
  await item(page, "Feed").click();
  await app.tabs.tab(0, "Feed").waitFor();
  // A view place opens in the window, and is marked.
  await item(page, "Tasks").click();
  await app.tabs.tab(0, "Tasks").waitFor();
  assert.deepEqual(await current(page), ["Tasks"]);
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
  await page.locator("#notes a", { hasText: "Tasks tour" }).first().click();
  await page.waitForFunction(() => document.title.startsWith("Tasks tour"));
  assert.equal(JSON.parse(await app.readFile(".common-ink/places.json")).saved["Tour notes"], "tour");
  // The Feed takes the list back; removing the search takes it out of places.json.
  await item(page, "Feed").click();
  assert.equal(await page.locator("#notes .list-head h2").textContent(), "All notes");
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

/** What this browser holds to send: whole files (`unsent`) and operations (`ops`), from IndexedDB. */
const heldHere = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ unsent: Array<{ path: string; conflict?: boolean }>; ops: Array<{ body: { places?: unknown } }> }>((done) => {
        const open = indexedDB.open("common-ink");
        open.onsuccess = () => {
          const tx = open.result.transaction(["unsent", "ops"]);
          const unsent = tx.objectStore("unsent").getAll();
          const ops = tx.objectStore("ops").getAll();
          tx.oncomplete = () => done({ unsent: unsent.result, ops: ops.result });
        };
      }),
  );
const savedSearch = async (page: Page, query: string, name: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#command-bar input").fill(query);
  await page.keyboard.press("ControlOrMeta+s");
  await page.locator(".dialog input").fill(name);
  await page.keyboard.press("Enter");
  await item(page, name).waitFor();
};
/** Once back online: places.json as the server has it, with nothing left held here and no clash. */
async function settled(app: App, want: (places: { saved?: Record<string, string>; bar?: string[] }) => boolean) {
  const { page } = app;
  for (let tries = 0; !want(JSON.parse((await app.readFile(".common-ink/places.json")) || "{}")); tries++) {
    assert.ok(tries < 80, `places.json is ${await app.readFile(".common-ink/places.json")}`);
    await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => !document.querySelector("#unsent")?.textContent, undefined, { timeout: 10_000 });
  const held = await heldHere(page);
  assert.deepEqual([held.unsent, held.ops], [[], []], "nothing left to send");
  assert.equal(await page.locator("#resolve").isVisible(), false, "no clash");
}

browserTest(h, "offline, two searches saved one after the other both reach places.json once back", { scenario: "preview", open: "Welcome", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] }, async (app) => {
  const { page } = app;
  await page.locator("#places .place-item").first().waitFor();
  await page.context().setOffline(true);
  await savedSearch(page, "garden", "Garden");
  await savedSearch(page, "launch", "Launch");
  // Each is held as the change it is, to be made on places.json as the server has it when it's sent.
  assert.equal((await heldHere(page)).ops.length, 2);
  await page.context().setOffline(false);
  await settled(app, (places) => places.saved?.Garden === "garden" && places.saved?.Launch === "launch" && places.saved?.Tours === "tour");
});

browserTest(h, "a search saved offline on a laptop while the phone changes the bottom bar: both are kept, and nothing clashes", { scenario: "preview", open: "Welcome", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] }, async (app) => {
  const { page } = app;
  await page.locator("#places .place-item").first().waitFor();
  await page.context().setOffline(true);
  await savedSearch(page, "garden", "Garden");
  // The phone, meanwhile, writes places.json with a new bar (from outside this page, which is offline).
  await app.writeFile(".common-ink/places.json", JSON.stringify({ ...JSON.parse(await app.readFile(".common-ink/places.json")), bar: ["feed", "tasks.tasks"] }, null, 2));
  await page.context().setOffline(false);
  await settled(app, (places) => places.saved?.Garden === "garden" && places.bar?.join() === "feed,tasks.tasks");
});
