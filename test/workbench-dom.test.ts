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
const { LAYOUT_PATH } = await import("../web/src/layout.ts");

/** A workbench over files in memory, starting from a saved layout, with every event a no-op. */
async function workbench(layout: unknown) {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const files = new Map<string, { text: string; revision: number }>([[LAYOUT_PATH, { text: JSON.stringify(layout), revision: 1 }]]);
  const net = {
    read: async (path: string) => ({ path, ...(files.get(path) ?? { text: `# ${path}`, revision: 1 }) }),
    unsentFor: async () => null,
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
