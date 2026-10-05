import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body><footer><span id=left></span><span id=right></span></footer></body>");
Object.assign(globalThis, { document: window.document });
const { StatusItems } = await import("../web/src/status-items.ts");

test("status bar items take their places from their manifests, and show only once their extension sets them", () => {
  const left = window.document.getElementById("left")!;
  const right = window.document.getElementById("right")!;
  const ran: string[] = [];
  const items = new StatusItems(left, right, (c) => ran.push(c));
  items.declare([
    { id: "words.count", alignment: "right", priority: 1, owner: "words", command: "words.show" },
    { id: "vim.mode", alignment: "left", priority: 100, owner: "vim" },
    { id: "timer.left", alignment: "right", priority: 5, owner: "timer" },
  ]);
  assert.deepEqual([...right.children].map((e) => (e as HTMLElement).dataset.item), ["words.count", "timer.left"], "higher priority further out");
  assert.ok((left.firstElementChild as HTMLElement).hidden, "empty until set");
  items.set("vim", "vim.mode", "INSERT");
  assert.equal(left.textContent, "INSERT");
  assert.equal((left.firstElementChild as HTMLElement).hidden, false);
  items.set("words", "words.count", "120 words", "Words in this note");
  (right.firstElementChild as HTMLElement).click();
  assert.deepEqual(ran, ["words.show"]);
  assert.throws(() => items.set("timer", "vim.mode", "hijacked"), /isn't declared in timer's/);
  items.set("vim", "vim.mode", "");
  assert.ok((left.firstElementChild as HTMLElement).hidden);
});
