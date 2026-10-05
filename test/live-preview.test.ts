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
});

const { EditorView } = await import("@codemirror/view");
const { Prec } = await import("@codemirror/state");
const { getCM, Vim, vim } = await import("@replit/codemirror-vim");
const { createState, reconfigure } = await import("../web/src/editor.ts");
// The two default extensions a note's editor has: Vim keys (first, as the Vim extension adds them) and the live preview.
const { markdownPreview } = await import("../web/src/extensions/live-preview/markdown.ts");
const { DEFAULTS } = await import("../worker/src/settings.ts");

const NOTE = [
  "# Trip plan",
  "**Pack** the *maps* and ~~skis~~ and `boots`.",
  "See [the itinerary](Itinerary.md) and [[Budget]] and [[Contacts|people]].",
  "> Bring snacks.",
  "---",
  "```",
  "**not bold** here",
  "```",
  "![Map](/uploads/map.png)",
  "",
].join("\n");

function editor(settings = DEFAULTS) {
  const view = new EditorView({
    state: createState(NOTE, { json: false, readOnly: false, settings, extensions: [Prec.highest(vim()), markdownPreview], onUpdate: () => {}, onBlur: () => {} }),
    parent: document.body,
  });
  // The cursor on the last, empty line: every other line is drawn.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

const shown = (view: InstanceType<typeof EditorView>) => [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);

test("markdown shows as it reads: markers hidden, links as their text, code raw", () => {
  const view = editor();
  const lines = shown(view);
  assert.equal(lines[0], "Trip plan");
  assert.equal(lines[1], "Pack the maps and skis and boots.");
  assert.equal(lines[2], "See the itinerary and Budget and people.");
  assert.equal(lines[3], "Bring snacks.");
  assert.equal(lines[4], "", "the rule is drawn, not written");
  assert.ok(view.contentDOM.querySelector(".cm-md-hr"));
  assert.deepEqual(lines.slice(5, 8), ["```", "**not bold** here", "```"], "code blocks stay raw");
  assert.equal(view.contentDOM.querySelectorAll(".cm-md-codeblock").length, 3);
  assert.ok(view.contentDOM.querySelectorAll(".cm-line")[3].classList.contains("cm-md-quote"));
  assert.deepEqual(
    [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-link")].map((l) => [l.textContent, l.dataset.href]),
    [
      ["the itinerary", "Itinerary.md"],
      ["Budget", "Budget"],
      ["people", "Contacts"],
    ],
  );
  assert.equal(view.contentDOM.querySelector<HTMLImageElement>("img.cm-md-image")?.getAttribute("src"), "/uploads/map.png");
  view.destroy();
});

test("the line the cursor is on shows its raw markdown", () => {
  const view = editor();
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } });
  assert.equal(shown(view)[1], "**Pack** the *maps* and ~~skis~~ and `boots`.");
  assert.equal(shown(view)[0], "Trip plan", "the others stay drawn");
  // A line's own style stays as the cursor comes onto it: a code line is still a code line.
  view.dispatch({ selection: { anchor: view.state.doc.line(7).from + 2 } });
  assert.ok(view.contentDOM.querySelectorAll(".cm-line")[6].classList.contains("cm-md-codeblock"));
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 2 } });
  assert.ok(view.contentDOM.querySelectorAll(".cm-line")[3].classList.contains("cm-md-quote"));
  assert.equal(shown(view)[3], "> Bring snacks.", "with its markers back");
  view.destroy();
});

test("Vim motions move over the raw text: w, e, f and x never land inside a hidden marker", () => {
  const view = editor();
  const cm = getCM(view)!;
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
  Vim.handleKey(cm, "w", "test");
  assert.equal(view.state.selection.main.head - view.state.doc.line(2).from, 2, "w goes from ** to Pack, as on raw text");
  Vim.handleKey(cm, "e", "test");
  assert.equal(view.state.selection.main.head - view.state.doc.line(2).from, 5);
  Vim.handleKey(cm, "f", "test");
  Vim.handleKey(cm, "*", "test");
  assert.equal(view.state.selection.main.head - view.state.doc.line(2).from, 6, "f* finds the closing marker");
  Vim.handleKey(cm, "x", "test");
  assert.equal(view.state.doc.line(2).text, "**Pack* the *maps* and ~~skis~~ and `boots`.");
  view.destroy();
});

test("with editor.livePreview off, every line is raw, and turning it on draws them again", () => {
  const view = editor({ ...DEFAULTS, "editor.livePreview": false });
  assert.equal(shown(view)[1], "**Pack** the *maps* and ~~skis~~ and `boots`.");
  reconfigure(view, DEFAULTS);
  assert.equal(shown(view)[1], "Pack the maps and skis and boots.");
  view.destroy();
});
