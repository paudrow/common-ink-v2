// A browser that ran navigation-1-14 (the navigation redesign, taken out for now) can have a change to
// places.json held to send, as navigation held them: this version lets it go, unsent.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

/** A held change as navigation-1-14 kept it in IndexedDB: removing a saved search, made offline. */
const HELD = { id: "001791477840931-000001", method: "PATCH", body: { places: { key: "saved", name: "Tours", query: null } }, what: "Places: the saved searches" };

/** How many changes are held to send, after putting `held` with them if it's given. */
const heldOps = (app: App, held: typeof HELD | null) =>
  app.page.evaluate(
    (held) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("common-ink", 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("ops", "readwrite");
          if (held) tx.objectStore("ops").put(held, held.id);
          const count = tx.objectStore("ops").count();
          tx.oncomplete = () => {
            open.result.close();
            resolve(count.result);
          };
        };
      }),
    held,
  );

browserTest(h, "a Places change navigation held offline is let go, not sent as an event's edit, and says nothing", { scenario: "lists", open: "Lists tour" }, async (app) => {
  const sent: string[] = [];
  app.page.on("request", (r) => r.url().includes("/api/event") && sent.push(`${r.method()} ${r.url()}`));
  assert.equal(await heldOps(app, HELD), 1, "held, as navigation left it");
  await app.reload();
  await app.idle();
  assert.equal(await heldOps(app, null), 0, "let go");
  assert.deepEqual(sent, [], "nothing was sent to the events API");
  assert.deepEqual((await app.state()).notices, []);
});
