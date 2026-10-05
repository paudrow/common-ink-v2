// The Extensions view in a DOM: a row each, and details in a modal that keeps the keyboard and gives it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent, CSS: { escape: (s: string) => s } });
const { parseManifest } = await import("../worker/src/extensions.ts");
const { extensionsView } = await import("../web/src/extensions-view.ts");
const { modalOpen } = await import("../web/src/modal.ts");
type Record = import("../web/src/extension-host.ts").ExtensionRecord;

function record(id: string, more: { [key: string]: unknown } = {}, workspace = false): Record {
  const manifest = parseManifest({ name: id[0].toUpperCase() + id.slice(1), version: "1.0.0", ...more }, id);
  if (typeof manifest === "string") throw new Error(manifest);
  const builtIn = workspace ? undefined : { manifest, module: { activate() {} }, sources: { "index.js": "export default { activate() {} };" }, folder: `web/src/extensions/${id}` };
  return { id, manifest, builtIn, workspace: workspace ? { id, manifestPath: "", files: [], version: "1" } : undefined, state: "active" } as unknown as Record;
}

function setUp() {
  const records = [
    record("vim", { description: "Vim keys.", contributes: { commands: [{ command: "vim.toggle", title: "Toggle Vim" }] } }),
    record("word-count", { description: "Counts words.", permissions: { "files:read": { paths: ["**/*.md"], why: "Count the words in the note on show" } } }, true),
  ];
  const disabled = new Set<string>();
  const view = extensionsView({
    records: () => records,
    needsReload: () => new Set(disabled),
    isOn: (id) => !disabled.has(id),
    setOn: async (id, on) => {
      if (on) disabled.delete(id);
      else disabled.add(id);
      view.render(root);
    },
    safe: false,
    openSource: () => {},
    openSettings: () => {},
    customize: async () => {},
    remove: async () => {},
    reload: () => {},
  });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  view.render(root);
  return { view, root };
}

const key = (target: Element, key: string, shiftKey = false) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

test("the list is a row each, in sections; a row opens its details in a modal", () => {
  const { root } = setUp();
  assert.deepEqual(
    [...root.querySelectorAll(".extension-section")].map((s) => [s.querySelector("h2")!.textContent, [...s.querySelectorAll(".extension-name")].map((n) => n.textContent)]),
    [
      ["Installed", ["Word-count"]],
      ["Built-in", ["Vim"]],
    ],
  );
  const open = root.querySelector<HTMLButtonElement>('[data-focus="open:word-count"]')!;
  open.focus();
  open.click();
  assert.equal(dialog()?.getAttribute("aria-modal"), "true");
  assert.equal(dialog()?.getAttribute("aria-label"), "Word-count");
  assert.equal(document.activeElement, dialog(), "focus moves into the modal");
  assert.equal(dialog()!.querySelector(".perm-can")!.textContent, "Read all your notes");
  assert.equal(dialog()!.querySelector(".perm-why")!.textContent, "Word-count says: “Count the words in the note on show”");
  dialog()!.querySelector<HTMLElement>(".modal-close")!.click();
});

test("Tab stays in the modal, Escape closes it, and focus goes back to the row", () => {
  const { root } = setUp();
  const open = root.querySelector<HTMLButtonElement>('[data-focus="open:vim"]')!;
  open.focus();
  open.click();
  const stops = [...dialog()!.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
  assert.ok(stops.length >= 3);
  key(dialog()!, "Tab");
  assert.equal(document.activeElement, stops[0], "Tab from the modal itself goes to its first control");
  stops.at(-1)!.focus();
  key(stops.at(-1)!, "Tab");
  assert.equal(document.activeElement, stops[0], "and from the last, back to the first");
  key(stops[0], "Tab", true);
  assert.equal(document.activeElement, stops.at(-1), "Shift-Tab from the first goes to the last");
  assert.equal(modalOpen(), true);
  key(document.activeElement!, "Escape");
  assert.equal(dialog(), null);
  assert.equal(modalOpen(), false);
  assert.equal(document.activeElement, open, "focus is back on the row");
});

test("the details show what's true now, keep focus when drawn again, and give focus to the row drawn since", async () => {
  const { view, root } = setUp();
  root.querySelector<HTMLButtonElement>('[data-focus="open:vim"]')!.click();
  const toggle = dialog()!.querySelector<HTMLInputElement>('[data-focus="details-on:vim"]')!;
  toggle.focus();
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event("change"));
  await Promise.resolve();
  assert.equal(dialog()!.querySelector(".extension-toggle")!.textContent, "Off");
  assert.equal(dialog()!.querySelector(".badge.reload")?.textContent, "Reload needed");
  assert.equal((document.activeElement as HTMLElement).dataset.focus, "details-on:vim", "focus stays on the switch, drawn again");
  assert.equal(root.querySelector<HTMLInputElement>('[data-focus="on:vim"]')!.checked, false, "and the row says so too");
  key(document.activeElement!, "Escape");
  assert.equal((document.activeElement as HTMLElement).dataset.focus, "open:vim", "the row, drawn again since, gets focus back");
  view.showDetails("gone");
  assert.match(dialog()!.textContent!, /There's no extension "gone" any more/);
  dialog()!.parentElement!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(dialog(), null, "a click outside closes them");
});

test("the search filters rows and hides sections with none", () => {
  const { root } = setUp();
  const search = root.querySelector<HTMLInputElement>(".extensions-search")!;
  search.value = "count";
  search.dispatchEvent(new window.Event("input"));
  assert.deepEqual(
    [...root.querySelectorAll<HTMLElement>(".extension-row")].filter((r) => !r.hidden).map((r) => r.dataset.extension),
    ["word-count"],
  );
  assert.deepEqual(
    [...root.querySelectorAll<HTMLElement>(".extension-section")].map((s) => s.hidden),
    [false, true],
  );
});
