import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><head></head><body></body>", { pretendToBeVisual: true });
// CodeMirror needs a page around it; Node's own navigator stays.
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  Window: window.Window,
});

const { EditorView } = await import("@codemirror/view");
const { commonmarkLanguage } = await import("@codemirror/lang-markdown");
import type { MarkdownParser } from "@lezer/markdown";
/** CommonMark's parser, as lang-markdown has it, to configure with an extension's syntax. */
const commonmark = commonmarkLanguage.parser as MarkdownParser;
const { LanguageDescription, syntaxTree } = await import("@codemirror/language");
const { languages } = await import("@codemirror/language-data");
const { parseCode } = await import("@lezer/markdown");
const { addMarkdownSyntax, createState } = await import("../web/src/editor.ts");
const { DEFAULTS } = await import("../worker/src/settings.ts");
const gfm = (await import("../web/src/extensions/gfm/index.ts")).default;
const codeBlocks = await import("../web/src/extensions/code-blocks/index.ts");
const latex = (await import("../web/src/extensions/latex/index.ts")).default;
const { math, texOf } = await import("../web/src/extensions/latex/syntax.ts");
import type { ExtensionContext } from "../web/src/extension-api.ts";

/** Start the three extensions as the app would, collecting what they add to note editors. */
const added: unknown[] = [];
const copied: string[] = [];
const settings: Record<string, unknown> = { "code-blocks.wrap": true };
const ctx = {
  editor: { markdown: addMarkdownSyntax, extend: (e: unknown) => void added.push(e), focused: () => null },
  settings: { get: (key: string) => settings[key] },
  clipboard: { write: async (text: string) => void copied.push(text) },
} as unknown as ExtensionContext;
for (const ext of [gfm, codeBlocks.default, latex]) ext.activate(ctx);

function editor(doc: string, cursorAtEnd = true) {
  const view = new EditorView({
    state: createState(doc, { json: false, readOnly: false, settings: DEFAULTS, extensions: added as never, onUpdate: () => {}, onBlur: () => {} }),
    parent: document.body,
  });
  if (cursorAtEnd) view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

const names = (parser: { parse(text: string): { iterate(o: { enter(n: { name: string }): void }): void } }, text: string) => {
  const seen = new Set<string>();
  parser.parse(text).iterate({ enter: (n) => void seen.add(n.name) });
  return seen;
};

const TABLE = "| Fruit | Count |\n|:--|--:|\n| **Apple** | 3 |\n| `Pear` | 10 |\n\nAfter.\n";

test("GFM: a table draws as a table until the cursor is in it, and without GFM there's no table at all", () => {
  assert.ok(!names(commonmarkLanguage.parser, TABLE).has("Table"), "CommonMark alone has no tables");
  const view = editor(TABLE);
  const table = view.dom.querySelector(".cm-gfm-table table")!;
  assert.deepEqual(
    [...table.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent)),
    [
      ["Fruit", "Count"],
      ["Apple", "3"],
      ["Pear", "10"],
    ],
  );
  assert.equal(table.querySelector("td strong")?.textContent, "Apple", "cells keep their formatting");
  assert.equal(table.querySelector("td code")?.textContent, "Pear");
  assert.equal((table.querySelectorAll("td")[1] as HTMLElement).style.textAlign, "right", "the delimiter row aligns columns");
  view.dispatch({ selection: { anchor: 3 } });
  assert.equal(view.dom.querySelector(".cm-gfm-table"), null, "the cursor in it shows its markdown");
  assert.match(view.contentDOM.textContent!, /\| Fruit \| Count \|/);
  view.destroy();
});

test("GFM: a bare address is a link, and strikethrough is parsed", () => {
  const view = editor("See https://example.com/a?b=1 and ~~old~~ news.\n\nEnd");
  const link = view.dom.querySelector<HTMLElement>(".cm-md-link")!;
  assert.equal(link.dataset.href, "https://example.com/a?b=1");
  const seen: string[] = [];
  syntaxTree(view.state).iterate({ enter: (n) => void seen.push(n.name) });
  assert.ok(seen.includes("Strikethrough"));
  view.destroy();
});

test("code blocks: a block's language loads on first use, then its code parses in that language", async () => {
  const python = LanguageDescription.matchLanguageName(languages, "python")!;
  assert.equal(python.support, undefined, "not loaded until a block names it");
  const skipping = codeBlocks.codeParser("python");
  assert.ok(skipping, "while it loads, the block is skipped");
  await python.load();
  assert.equal(codeBlocks.codeParser("python  title=x"), python.support!.language.parser, "only the first word names the language");
  assert.equal(codeBlocks.codeParser("not-a-language"), null);
  // The code's tree is mounted in the block's, where the highlighter (and resolveInner) find it.
  const tree = commonmark.configure(parseCode({ codeParser: codeBlocks.codeParser })).parse("```python\ndef f():\n    return 1\n```\n");
  assert.equal(tree.resolveInner(12, 1).parent?.name, "FunctionDefinition", "the code is Python's syntax tree");
});

test("code blocks: Copy copies the code, and Wrap flips wrapping for that block alone", async () => {
  const view = editor("```js\nconst x = 1;\nconsole.log(x);\n```\n\n```\nplain\n```\n\nEnd");
  const tools = view.dom.querySelectorAll<HTMLElement>(".cm-code-tools");
  assert.equal(tools.length, 2, "each block has its buttons on its first line");
  const [wrap, copy] = [...tools[0].querySelectorAll("button")];
  assert.equal(wrap.getAttribute("aria-pressed"), "true", "wrapping, as the setting says");
  copy.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, ["const x = 1;\nconsole.log(x);"]);
  wrap.click();
  const unwrapped = () => [...view.contentDOM.querySelectorAll(".cm-line.cm-code-nowrap")].map((l) => l.textContent!.replace(/WrapCopy$/, ""));
  assert.deepEqual(unwrapped(), ["```js", "const x = 1;", "console.log(x);", "```"], "that block's lines, and not the other's");
  assert.equal(view.dom.querySelector(".cm-code-tools button")!.getAttribute("aria-pressed"), "false");
  view.dispatch({ changes: { from: 0, insert: "Intro\n\n" } });
  assert.equal(unwrapped().length, 4, "its choice follows the block as the note changes");
  view.destroy();
});

test("LaTeX: $…$ and $$…$$ parse as math, prices don't, and each draws with KaTeX", async () => {
  const parser = commonmark.configure(math);
  assert.ok(names(parser, "Area is $\\pi r^2$ here.").has("InlineMath"));
  assert.ok(!names(parser, "It cost $5 and $10.").has("InlineMath"), "a digit after the closing $: not math");
  assert.ok(!names(parser, "From $ 1 to 2 $.").has("InlineMath"), "a space inside the dollars: not math");
  assert.ok(!names(parser, "`$x$`").has("InlineMath"), "code stays code");
  assert.ok(names(parser, "Text\n$$\n\\int_0^1 x\\,dx\n$$\nMore").has("BlockMath"), "$$ on its own line ends a paragraph");
  assert.equal(texOf("$$\n\\int x\n$$", true), "\\int x");
  assert.equal(texOf("$x^2$", false), "x^2");

  const view = editor("Inline $x^2$ math.\n\n$$\n\\frac{a}{b}\n$$\n\nEnd");
  const drawn = () => [...view.dom.querySelectorAll<HTMLElement>(".cm-math")];
  assert.deepEqual(
    drawn().map((m) => m.classList.contains("cm-math-display")),
    [false, true],
  );
  for (let i = 0; i < 50 && !view.dom.querySelector(".katex"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(drawn().every((m) => m.querySelector(".katex")), "KaTeX drew both");
  assert.match(document.head.innerHTML, /\/assets\/katex-[\d.]+\/katex\.min\.css/, "with its styles from the app");
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  assert.deepEqual(drawn().map((m) => m.classList.contains("cm-math-display")), [false], "the cursor in the equation shows its TeX");
  view.destroy();
});
