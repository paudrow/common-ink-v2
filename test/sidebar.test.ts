import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, KeyboardEvent: window.KeyboardEvent });

const { Sidebar, GoKeys } = await import("../web/src/sidebar.ts");
type Place = import("../web/src/shell.ts").Place;

const PLACES: Place[] = [
  { id: "feed", title: "Feed", icon: "inbox", open: { list: true } },
  { id: "daily.today", title: "Today", icon: "sun", open: { command: "daily.today" }, from: "Daily notes" },
  { id: "tasks.tasks", title: "Tasks", icon: "list-checks", open: { view: "tasks" } },
  { id: "view:trash", title: "Trash", icon: "file-text", open: { view: "trash" } },
  { id: "data-sources.sources", title: "Sources", icon: "database-zap", open: { view: "dataSources" } },
  { id: "view:archive", title: "Archive", icon: "file-text", open: { view: "archive" } },
  { id: "extensions", title: "Extensions", icon: "puzzle", open: { view: "extensions" }, end: true },
  { id: "settings", title: "Settings", icon: "settings", open: { view: "settings" }, end: true },
];

function sidebar(more: { pinned?: Array<{ path: string; title: string }>; saved?: Array<{ name: string; query: string; count?: string }>; current?: unknown } = {}) {
  const did: string[] = [];
  const s = new Sidebar({
    places: () => PLACES,
    pinned: () => (more.pinned ?? []) as never,
    saved: () => more.saved ?? [],
    current: () => (more.current ?? { place: "feed" }) as never,
    go: (p) => did.push(`go ${p.id}`),
    openPinned: (p) => did.push(`pinned ${p}`),
    openSaved: (q) => did.push(`saved ${q.name}`),
    removeSaved: (q) => did.push(`remove ${q.name}`),
    search: () => did.push("search"),
  });
  document.body.replaceChildren(s.root);
  s.render();
  const sections = () => [...s.root.querySelectorAll("section")].map((sec) => [sec.querySelector("h3")?.textContent ?? "", [...sec.querySelectorAll(".place-title")].map((t) => t.textContent)]);
  const click = (title: string) => ([...s.root.querySelectorAll<HTMLButtonElement>("button.place-item")].find((b) => b.querySelector(".place-title")!.textContent === title)!).click();
  return { s, did, sections, click };
}

test("Places lists where you go, then pinned notes and saved searches, then Sources, Archive, Trash, Extensions and Settings", () => {
  const { sections } = sidebar({ pinned: [{ path: "Launch plan.md", title: "Launch plan" }], saved: [{ name: "Agent edits", query: "from:agent", count: "6" }] });
  assert.deepEqual(sections(), [
    ["", ["Feed", "Search", "Today", "Tasks"]],
    ["Pinned", ["Launch plan"]],
    ["Saved searches", ["Agent edits"]],
    ["", ["Sources", "Archive", "Trash", "Extensions", "Settings"]],
  ]);
  // With none pinned or saved, those sections aren't there.
  assert.deepEqual(sidebar().sections().map(([h]) => h), ["", ""]);
});

test("each item goes where it says, the current one is marked, and a saved search can be removed", () => {
  const { s, did, click } = sidebar({ pinned: [{ path: "Launch plan.md", title: "Launch plan" }], saved: [{ name: "Agent edits", query: "from:agent", count: "6" }], current: { saved: "Agent edits" } });
  for (const t of ["Tasks", "Search", "Launch plan", "Agent edits", "Trash"]) click(t);
  s.root.querySelector<HTMLButtonElement>(".place-remove")!.click();
  assert.deepEqual(did, ["go tasks.tasks", "search", "pinned Launch plan.md", "saved Agent edits", "go view:trash", "remove Agent edits"]);
  assert.deepEqual([...s.root.querySelectorAll("[aria-current]")].map((b) => b.textContent), ["Agent edits6"]);
  assert.equal(s.root.querySelector(".place-from")!.textContent, "Daily notes", "an extension's place says whose it is");
});

test("with focus in Places, j and k move and l opens", () => {
  const { s, did } = sidebar();
  s.focus();
  const key = (k: string) => (document.activeElement as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  for (const k of ["j", "j", "j", "k"]) key(k);
  key("l");
  assert.deepEqual(did, ["go daily.today"]);
});

test("the go keys: g, then a key, outside text; g stays a letter in a field and Vim's in a note", () => {
  const went: string[] = [];
  const go = new GoKeys((k) => (went.push(k), k !== "q"));
  const press = (k: string, target: Element = document.body, mods: { ctrlKey?: boolean } = {}) => go.key({ key: k, target, metaKey: false, altKey: false, ctrlKey: false, ...mods } as never);
  assert.deepEqual([press("g"), press("x")], [false, true]);
  assert.deepEqual([press("g"), press("Shift"), press("/")], [false, false, true]);
  // A key that goes nowhere is left to whatever has focus, and so is gg.
  assert.deepEqual([press("g"), press("q"), press("g"), press("g")], [false, false, false, false]);
  const field = document.createElement("input");
  const note = Object.assign(document.createElement("div"), { className: "cm-editor" });
  note.append(document.createElement("p"));
  document.body.append(field, note);
  assert.deepEqual([press("g", field), press("x", field), press("g", note.firstChild as Element), press("x", note.firstChild as Element)], [false, false, false, false]);
  assert.deepEqual([press("g"), press("x", document.body, { ctrlKey: true })], [false, false]);
  assert.deepEqual(went, ["x", "/", "q"]);
});
