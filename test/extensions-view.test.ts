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
    record("vim", { description: "Vim keys.", contributes: { commands: [{ command: "vim.toggle", title: "Toggle Vim" }] }, permissions: { editor: { why: "Vim keys in every editor" } } }),
    record("reading-time", { description: "Counts words.", permissions: { "files:read": { paths: ["**/*.md"], why: "Count the words in the note on show" }, network: { hosts: ["api.example.com"], why: "Look words up" } } }, true),
  ];
  const disabled = new Set<string>();
  let answers: { [id: string]: { [key: string]: "allow" | "deny" } } = {};
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
    answer: (r, key) => answers[r.id]?.[key],
    setAnswer: async (r, key, answer) => {
      const mine = { ...answers[r.id] };
      if (answer) mine[key] = answer;
      else delete mine[key];
      answers = { ...answers, [r.id]: mine };
      view.render(root);
    },
    resetAnswers: async (r) => {
      const { [r.id]: _gone, ...others } = answers;
      answers = others;
      view.render(root);
    },
    isTrusted: () => false,
    setTrusted: async () => {},
    install: async () => {},
    showActivity: () => {},
    catalog: () => ({ entries: [{ id: "pomodoro", name: "Pomodoro", version: "1.0.0", description: "Focus timer.", folder: "https://app.example/catalog/pomodoro/", catalog: "Common Ink", firstParty: true, embeds: ["pomodoro"] }], problems: [] }),
    commandTitle: () => undefined,
    device: { summary: () => "Mac · Chrome · large width (1440px)", open() {}, here: () => ({ on: true, by: "default" }), override: () => undefined, setOverride: async () => {} },
    installFromCatalog: async () => {},
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
      ["Installed", ["Reading-time"]],
      ["Built-in", ["Vim"]],
      ["Catalog", ["Pomodoro"]],
    ],
  );
  const open = root.querySelector<HTMLButtonElement>('[data-focus="open:reading-time"]')!;
  open.focus();
  open.click();
  assert.equal(dialog()?.getAttribute("aria-modal"), "true");
  assert.equal(dialog()?.getAttribute("aria-label"), "Reading-time");
  assert.equal(document.activeElement, dialog(), "focus moves into the modal");
  assert.deepEqual(
    [...dialog()!.querySelectorAll(".extension-perms li")].map((li) => [li.querySelector(".perm-can")!.textContent, li.querySelector(".perm-why")!.textContent]),
    [
      ["Connect to api.example.com", "Reading-time says: “Look words up”"],
      ["Read all your notes", "Reading-time says: “Count the words in the note on show”"],
    ],
  );
  assert.equal(dialog()!.querySelector(".badge")!.textContent, "Workspace");
  dialog()!.querySelector<HTMLElement>(".modal-close")!.click();
});

test("Tab stays in the modal, Escape closes it, and focus goes back to the row", () => {
  const { root } = setUp();
  const open = root.querySelector<HTMLButtonElement>('[data-focus="open:vim"]')!;
  open.focus();
  open.click();
  const stops = [...dialog()!.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select")];
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
    ["reading-time"],
  );
  assert.deepEqual(
    [...root.querySelectorAll<HTMLElement>(".extension-section")].map((s) => s.hidden),
    [false, true, true],
  );
});

test("each permission shows your answer in the prompt's words; Reset forgets them all, so it asks again", async () => {
  const { root } = setUp();
  root.querySelector<HTMLButtonElement>('[data-focus="open:reading-time"]')!.click();
  const picks = () => [...dialog()!.querySelectorAll<HTMLSelectElement>("select.answer")];
  assert.deepEqual(
    picks().map((p) => [p.getAttribute("aria-label"), [...p.options].map((o) => o.textContent), p.selectedOptions[0].textContent]),
    [
      ["Reading-time: Connect to api.example.com", ["Ask", "Always allow", "Don't allow"], "Ask"],
      ["Reading-time: Read all your notes", ["Ask", "Always allow", "Don't allow"], "Ask"],
    ],
  );
  assert.equal(dialog()!.querySelector('[data-focus="reset:reading-time"]'), null, "nothing kept, nothing to reset");
  picks()[0].value = "deny";
  picks()[0].dispatchEvent(new window.Event("change"));
  picks()[1].value = "allow";
  picks()[1].dispatchEvent(new window.Event("change"));
  await Promise.resolve();
  assert.deepEqual(picks().map((p) => p.selectedOptions[0].textContent), ["Don't allow", "Always allow"]);
  dialog()!.querySelector<HTMLButtonElement>('[data-focus="reset:reading-time"]')!.click();
  await Promise.resolve();
  assert.deepEqual(picks().map((p) => p.selectedOptions[0].textContent), ["Ask", "Ask"]);
  key(document.activeElement!, "Escape");
  root.querySelector<HTMLButtonElement>('[data-focus="open:vim"]')!.click();
  assert.deepEqual(
    picks().map((p) => [[...p.options].map((o) => o.textContent), p.selectedOptions[0].textContent]),
    [[["Always allow", "Don't allow"], "Always allow"]],
    "a built-in has its permissions with the app, until you say Don't allow",
  );
  key(document.activeElement!, "Escape");
});
