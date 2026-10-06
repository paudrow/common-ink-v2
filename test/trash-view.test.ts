import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, KeyboardEvent: window.KeyboardEvent, HTMLElement: window.HTMLElement, getComputedStyle: window.getComputedStyle });

const { TrashView, KEPT_WHY } = await import("../web/src/extensions/trash/view.ts");
type Trashed = import("../web/src/extensions/trash/view.ts").Trashed;

const item = (over: Partial<Trashed>): Trashed => ({ path: "Note.md", title: "Note", revision: 1, before: 0, author: { kind: "user", email: "ada@example.com" }, time: Date.now(), daysLeft: 30, ...over });

function draw(items: Trashed[]) {
  const view = new TrashView({ me: "ada@example.com", retentionDays: () => 30, restore() {}, deleteForever() {}, empty() {}, lastVersion: async () => "" });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  view.show(items);
  view.render(root);
  return root;
}

test("a Kept note says why where a phone shows it, and Trash's count doesn't say retention takes it", () => {
  const root = draw([item({ revision: 2, byHand: true, path: "Journal/2026-10-01.md", title: "2026-10-01" }), item({ revision: 1 })]);
  assert.equal(root.querySelector(".trash-top span")!.textContent, "2 notes: 1 kept until you delete it forever, the rest deleted forever 30 days after they were deleted");
  assert.match(root.querySelector(".trash-row .trash-detail")!.textContent!, /kept until you delete it forever$/);
  // Tapped, it says why in full.
  (root.querySelector(".trash-row .trash-look") as HTMLElement).click();
  assert.equal(root.querySelector(".trash-why")?.textContent, KEPT_WHY);
  assert.equal(draw([item({ byHand: true })]).querySelector(".trash-top span")!.textContent, "1 note, kept until you delete it forever");
});

test("a note with earlier parts says what deleting it forever takes besides", () => {
  const root = draw([item({ earlier: [{ path: "Journal/2026-10-01.md", text: "# 2026-10-01\n- the old day's plan" }] })]);
  (root.querySelector(".trash-row .trash-look") as HTMLElement).click();
  assert.deepEqual([...root.querySelectorAll(".trash-earlier li")].map((li) => li.textContent), ["Journal/2026-10-01.md: - the old day's plan"]);
});
