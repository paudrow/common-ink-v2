import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, KeyboardEvent: window.KeyboardEvent, getComputedStyle: window.getComputedStyle, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });

const { textDialog } = await import("../web/src/dialog.ts");

test("Enter in a one-line dialog answers it and goes no further, so it can't press what has focus next", async () => {
  const answer = textDialog("Install from URL", "Where it is", "https://…", "Install");
  await new Promise((r) => setTimeout(r, 0));
  const input = window.document.querySelector<HTMLInputElement>(".dialog input")!;
  input.value = " https://example.com/ext/ ";
  const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(await answer, "https://example.com/ext/");
});
