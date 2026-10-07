// Bugs people found by hand (regressions.browser.ts says more): an edit undone around its save, offline,
// held, or in another tab, is never sent.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { App } from "./pages.ts";

const h = harness();

browserTest(h, "an edit undone before it was saved isn't brought back by a reload", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.call("cursor", 1, 3);
  // Nothing reaches the server while this runs: the edit is only kept in this browser, as it's typed.
  await app.call("slow", "^PUT /api/file", 60_000);
  await app.keys("dw");
  await app.page.waitForTimeout(300);
  await app.keys("u");
  await app.page.waitForTimeout(300);
  await app.reload();
  await app.open("Trip");
  await app.idle();
  await app.page.waitForTimeout(800);
  await app.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip\n");
  assert.equal(await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "Trip" }).count(), 1);
});

for (const when of ["back online", "still offline"] as const) {
  browserTest(h, `an edit undone while offline, after its save was held, isn't saved by a reload ${when}`, { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] }, async (app) => {
    await app.writeFile("Trip.md", "# Trip\nalpha beta gamma\n");
    await app.goto({}, "Trip");
    await app.idle();
    await app.call("cursor", 2, 1);
    await app.page.context().setOffline(true);
    await app.keys("dw");
    // Long enough for its save to fail and the edit to be held, to send once back online.
    await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent?.includes("1 unsent change"));
    await app.keys("u");
    await app.page.waitForTimeout(200);
    if (when === "back online") await app.page.context().setOffline(false);
    await app.page.reload().catch(() => {});
    await app.page.waitForTimeout(1000);
    await app.page.context().setOffline(false);
    // A reload that failed offline left the browser's error page, which loads the app again by itself
    // once back online: that load runs first, so the next one doesn't cut it short.
    await app.page.waitForURL((url) => url.origin === new URL(app.base).origin);
    await app.ready();
    await app.goto({}, "Trip");
    await app.idle();
    await app.page.waitForTimeout(1500);
    await app.idle();
    assert.equal(await app.readFile("Trip.md"), "# Trip\nalpha beta gamma\n");
  });
}

browserTest(h, "leaving the page the moment after an edit is undone doesn't send the edit next time", { scenario: "empty" }, async (app) => {
  for (let run = 0; run < 3; run++) {
    await app.writeFile("Trip.md", "# Trip\nalpha beta gamma\n");
    await app.goto({}, "Trip");
    await app.idle();
    await app.call("cursor", 2, 1);
    await app.call("slow", "^PUT /api/file", 60_000);
    await app.keys("dw");
    await app.page.waitForTimeout(run * 100);
    await app.keys("u");
    await app.page.goto("about:blank");
    await app.goto({}, "Trip");
    await app.idle();
    await app.page.waitForTimeout(800);
    await app.idle();
    assert.equal(await app.readFile("Trip.md"), "# Trip\nalpha beta gamma\n", `run ${run}`);
  }
});

for (const order of ["B leaves, then A", "A leaves, then B"] as const) {
  browserTest(h, `one tab's edit undone doesn't let go of another tab's offline edit of the same note (${order})`, { scenario: "empty", allowErrors: [/./] }, async (app) => {
    await app.writeFile("Trip.md", "# Trip\nalpha beta gamma\n");
    const b = new App(await app.page.context().newPage(), app.base);
    for (const x of [app, b]) {
      await x.goto({}, "Trip");
      await x.idle();
    }
    // Offline in the page itself (requests fail as the page goes, too), as a lost connection is.
    await app.page.context().setOffline(true);
    for (const x of [app, b]) await x.call("levers.set", { offline: true });
    // B's edit, held: its save failed.
    await b.call("cursor", 2, 1);
    await b.keys("A fromB<Esc>");
    await b.page.waitForTimeout(1800);
    // A's own edit, undone.
    await app.call("cursor", 2, 1);
    await app.keys("dw");
    await app.keys("u");
    await app.page.waitForTimeout(400);
    for (const x of order === "B leaves, then A" ? [b, app] : [app, b]) {
      await x.page.goto("about:blank");
      await x.page.close();
    }
    await app.page.context().setOffline(false);
    // The offline lever is kept in a cookie for the page's reloads: a new page starts without it.
    await app.page.context().clearCookies();
    const c = new App(await app.page.context().newPage(), app.base);
    await c.goto({}, "Trip");
    await c.idle();
    for (let i = 0; i < 20 && (await c.readFile("Trip.md")) !== "# Trip\nalpha beta gamma fromB\n"; i++) await c.page.waitForTimeout(250);
    assert.equal(await c.readFile("Trip.md"), "# Trip\nalpha beta gamma fromB\n");
    await c.page.close();
  });
}

browserTest(h, "an edit held offline and undone in a tab that closes at once isn't sent by another tab's background send", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\nalpha beta gamma\n");
  await app.writeFile("Other.md", "# Other\n");
  // A page of its own, whose clock runs: its background send is what's tested.
  const other = new App(await app.page.context().newPage(), app.base);
  await other.goto({}, "Other");
  await other.idle();
  const a = new App(await app.page.context().newPage(), app.base);
  await a.goto({}, "Trip");
  await a.idle();
  await a.call("cursor", 2, 1);
  await app.page.context().setOffline(true);
  await a.keys("dw");
  await a.page.waitForFunction(() => document.querySelector("#unsent")?.textContent?.includes("1 unsent change"));
  // The page goes before letting go of what it held in IndexedDB gets there: here, it never does.
  await a.page.evaluate(() => {
    IDBObjectStore.prototype.delete = () => ({}) as IDBRequest;
  });
  await a.keys("u");
  await a.page.close();
  await app.page.context().setOffline(false);
  // The other tab sends what's held every five seconds, and as it comes back online.
  await other.page.waitForTimeout(6500);
  await other.idle();
  assert.equal(await app.readFile("Trip.md"), "# Trip\nalpha beta gamma\n");
  await other.page.close();
});

browserTest(h, "an edit undone while its failed save is still being held isn't sent by another tab, or when the note opens again", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile("Other.md", "# Other\n");
  // A page of its own, whose clock runs: its background send is what's tested.
  const other = new App(await app.page.context().newPage(), app.base);
  await other.goto({}, "Other");
  await other.idle();
  const held = () =>
    other.page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open("common-ink");
          open.onsuccess = () => {
            const count = open.result.transaction("unsent").objectStore("unsent").count();
            count.onsuccess = () => (resolve(count.result), open.result.close());
          };
        }),
    );
  // How soon the page goes after the edit is held decides whether a later save of it lets go again: a few tries.
  for (const note of ["Trip1", "Trip2", "Trip3"]) {
    await app.writeFile(`${note}.md`, "# Trip\nalpha beta gamma\n");
    const a = new App(await app.page.context().newPage(), app.base);
    // Reads of held edits wait while the gate is shut, as a slow device's IndexedDB keeps them waiting.
    await a.page.addInitScript(() => {
      const w = window as unknown as { gate?: Promise<void> };
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
        const tx = transaction.apply(this, args);
        const gate = w.gate;
        if (gate && (args[1] ?? "readonly") === "readonly" && [args[0]].flat().includes("unsent"))
          Object.defineProperty(tx, "oncomplete", { configurable: true, set: (fn: (e: Event) => void) => tx.addEventListener("complete", (e) => void gate.then(() => fn.call(tx, e))) });
        return tx;
      } as typeof transaction;
    });
    await a.goto({}, note);
    await a.idle();
    await a.call("cursor", 2, 1);
    await a.page.evaluate(() => {
      const w = window as unknown as { gate?: Promise<void>; open?: () => void };
      w.gate = new Promise((r) => (w.open = r));
    });
    await app.page.context().setOffline(true);
    await a.keys("dw");
    // Polled by time, not by frame: a page behind another draws no frames.
    await a.page.waitForFunction(() => document.querySelector("#save")?.getAttribute("data-status") === "offline", undefined, { polling: 20 });
    // `u` while the failed save is still being held; the page goes the moment it's held.
    await a.keys("u");
    await a.page.evaluate(() => (window as unknown as { open: () => void }).open());
    for (let i = 0; i < 100 && !(await held()); i++) await other.page.waitForTimeout(5);
    await a.page.close();
    await app.page.context().setOffline(false);
    await other.page.waitForTimeout(6500);
    assert.equal(await app.readFile(`${note}.md`), "# Trip\nalpha beta gamma\n", `${note}: not sent by the other tab`);
    const again = new App(await app.page.context().newPage(), app.base);
    await again.goto({}, note);
    await again.idle();
    await again.page.waitForTimeout(1500);
    assert.equal(await app.readFile(`${note}.md`), "# Trip\nalpha beta gamma\n", `${note}: not sent as it opens again`);
    await again.page.close();
  }
  await other.page.close();
});
