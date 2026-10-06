import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  Window: window.Window,
  HTMLElement: window.HTMLElement,
  CSS: { escape: (s: string) => s },
});
const { Workbench } = await import("../web/src/workbench.ts");
const { LAYOUT_PATH, focusGroup } = await import("../web/src/layout.ts");
const { EditorSelection } = await import("@codemirror/state");
import type { FilePath } from "../worker/src/files.ts";

/** A workbench over files in memory, starting from a saved layout, with every event a no-op. */
async function workbench(layout: unknown, notes: Record<string, string> = {}) {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const files = new Map<string, { text: string; revision: number }>([[LAYOUT_PATH, { text: JSON.stringify(layout), revision: 1 }], ...Object.entries(notes).map(([path, text]) => [path, { text, revision: 1 }] as [string, { text: string; revision: number }])]);
  const net = {
    read: async (path: string) => ({ path, ...(files.get(path) ?? { text: `# ${path}`, revision: 1 }) }),
    keptEdit: async () => undefined,
    keepDraft: async () => {},
    landed: async () => {},
    letGoOwn: async () => {},
    dropDraft: async () => {},
    write: async (path: string, text: string, base: number) => {
      files.set(path, { text, revision: base + 1 });
      return { status: "saved", file: { path, text, revision: base + 1 } };
    },
    hold: async () => {},
    release: async () => {},
  };
  const on = new Proxy({}, { get: () => () => undefined });
  const wb = new Workbench(host, on as never, net as never);
  await wb.start();
  return { wb, host };
}

const group = (id: string, file: string) => ({ kind: "group", id, tabs: [{ file }], active: 0 });

test("closing a split's other window leaves the one that's left filling the area, not the share it had", async () => {
  const { wb, host } = await workbench({ root: { kind: "split", dir: "row", children: [group("g1", "A.md"), group("g2", "B.md")], sizes: [0.3, 0.7] }, focus: "g2" });
  const windows = () => [...host.querySelectorAll<HTMLElement>(".group")];
  const share = (w: HTMLElement) => w.style.getPropertyValue("--share");
  assert.deepEqual(windows().map(share), ["0.3", "0.7"], "in the split, each window has its share");
  await wb.closeGroup();
  assert.equal(windows().length, 1);
  assert.equal(share(windows()[0]), "", "no stale share of a split that's gone");
  assert.equal(windows()[0].parentElement, host, "it's the whole area");
});

test("a saved layout with a split of one (from before splits were tidied on load) opens as one window, filling the area", async () => {
  const { host } = await workbench({ root: { kind: "split", dir: "row", children: [group("g1", "A.md")], sizes: [0.5] }, focus: "g1" });
  assert.equal(host.querySelector(".split"), null);
  assert.equal(host.querySelectorAll(".group").length, 1);
  assert.equal(host.querySelector<HTMLElement>(".group")!.style.getPropertyValue("--share"), "");
});

/** Where the workbench is: the focused window and the file it shows. */
const where = (wb: Awaited<ReturnType<typeof workbench>>["wb"]) => [wb.layout.focus, wb.focusedPath];

test("back and forward go between windows and files, each where you were", async () => {
  const { wb } = await workbench({ root: { kind: "split", dir: "row", children: [group("g1", "A.md"), group("g2", "B.md")], sizes: [0.5, 0.5] }, focus: "g1" });
  await wb.open("C.md" as FilePath);
  wb.change((l) => focusGroup(l, "g2"));
  assert.deepEqual(where(wb), ["g2", "B.md"]);
  assert.ok(await wb.go(-1));
  assert.deepEqual(where(wb), ["g1", "C.md"], "back into the other window, to the file opened there");
  assert.ok(await wb.go(-1));
  assert.deepEqual(where(wb), ["g1", "A.md"]);
  assert.equal(await wb.go(-1), false, "nothing before where the page opened");
  assert.ok(await wb.go(1));
  assert.ok(await wb.go(1));
  assert.deepEqual(where(wb), ["g2", "B.md"], "and forward again, across the split");
});

test("a place whose preview tab was replaced comes back in the preview tab; a closed window's, in the window focused", async () => {
  const { wb } = await workbench({ root: { kind: "group", id: "g1", tabs: [], active: 0 }, focus: "g1" });
  await wb.open("A.md" as FilePath);
  await wb.open("B.md" as FilePath);
  assert.deepEqual(wb.layout.root.kind === "group" ? wb.layout.root.tabs : null, [{ file: "B.md", preview: true }], "B took A's preview tab");
  await wb.go(-1);
  assert.deepEqual(wb.layout.root.kind === "group" ? wb.layout.root.tabs : null, [{ file: "A.md", preview: true }], "A is back, in the preview tab");

  const two = await workbench({ root: { kind: "split", dir: "row", children: [group("g1", "A.md"), group("g2", "B.md")], sizes: [0.5, 0.5] }, focus: "g2" });
  await two.wb.open("C.md" as FilePath);
  await two.wb.closeGroup();
  assert.deepEqual(where(two.wb), ["g1", "A.md"]);
  await two.wb.go(-1);
  assert.deepEqual(where(two.wb), ["g1", "C.md"], "C's window is gone: it opens here");
});

test("moving the cursor about isn't a place of its own; a jump of more than ten lines is, and back returns to the line", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n");
  const { wb } = await workbench({ root: group("g1", "Long.md"), focus: "g1" }, { "Long.md": long });
  const view = wb.focusedView!;
  const to = (line: number) => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line).from) });
  const places = () => wb.navigation.toJSON().visits.length;
  for (const line of [2, 3, 5, 9, 4]) to(line);
  assert.equal(places(), 1, "steps: still the one place");
  to(45);
  assert.equal(places(), 2, "G or a search: a jump");
  await wb.go(-1);
  assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 4, "back where the cursor was before the jump");
});
