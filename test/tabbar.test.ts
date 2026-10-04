import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { syncTabs, type TabActions, type TabModel } from "../web/src/tabbar.ts";

const { window } = new JSDOM("<!doctype html><div id=bar></div>");
Object.assign(globalThis, { document: window.document });

function setup() {
  const bar = window.document.getElementById("bar")!;
  bar.replaceChildren();
  const calls: string[] = [];
  const actions: TabActions = {
    select: (k) => calls.push(`select ${k}`),
    close: (k) => calls.push(`close ${k}`),
    keep: (k) => calls.push(`keep ${k}`),
    menu: (k) => calls.push(`menu ${k}`),
    dragStart: (k) => calls.push(`drag ${k}`),
    dragEnd: () => {},
  };
  return { bar, calls, actions };
}

const tab = (key: string, extra: Partial<TabModel> = {}): TabModel => ({ key, label: key, title: key, selected: false, preview: false, ...extra });
const press = (el: Element, type: string) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0 }));

test("pressing a tab selects it, even when a save status changes before the button comes up", () => {
  const { bar, calls, actions } = setup();
  syncTabs(bar, [tab("a", { selected: true }), tab("b")], actions);
  const [a, b] = [...bar.children];
  const name = b.querySelector(".name")!;
  press(name, "pointerdown");
  // The editor loses focus, saves, and its tab shows the save under way.
  syncTabs(bar, [tab("a", { selected: true, status: "saving" }), tab("b")], actions);
  press(name, "pointerup");
  press(name, "click");
  assert.deepEqual(calls, ["select b", "select b"]);
  assert.equal(bar.children[0], a, "the tabs are the same nodes");
  assert.equal(bar.children[1], b);
  assert.equal(a.querySelector<HTMLElement>(".name")!.dataset.status, "saving");
});

test("tabs update in place, and only added, removed or moved tabs touch the nodes", () => {
  const { bar, actions } = setup();
  syncTabs(bar, [tab("a"), tab("b"), tab("c")], actions);
  const [a, b, c] = [...bar.children];
  syncTabs(bar, [tab("c", { selected: true, preview: true, label: "C!" }), tab("a")], actions);
  assert.deepEqual([...bar.children], [c, a]);
  assert.equal(b.isConnected, false);
  assert.equal(c.getAttribute("aria-selected"), "true");
  assert.equal(c.classList.contains("preview"), true);
  assert.equal(c.querySelector(".name")!.textContent, "C!");
});

test("the close button, a double-click and the menu each do their own thing", () => {
  const { bar, calls, actions } = setup();
  syncTabs(bar, [tab("a"), tab("b")], actions);
  const b = bar.children[1];
  press(b.querySelector(".close")!, "click");
  b.querySelector(".name")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  b.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
  b.querySelector(".name")!.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 2 }));
  assert.deepEqual(calls, ["close b", "keep b", "menu b"]);
});
