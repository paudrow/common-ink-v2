// LaTeX, a built-in extension: $…$ and $$…$$ parsed in notes (syntax.ts) and drawn with KaTeX, which
// loads, with its styles and fonts from the app, the first time a note has math. Inline math is drawn
// where the cursor's line isn't; a displayed equation, until the cursor is in it.
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { blockHeight, blockPreview, livePreview, measureBlock, type BlockPreview, type Preview } from "common-ink/live-preview";
import type { ExtensionContext } from "../../extension-api.ts";
import { math, texOf } from "./syntax.ts";

type Katex = { render(tex: string, el: HTMLElement, options: Record<string, unknown>): void; version: string };

let katex: Promise<Katex> | null = null;

/** KaTeX, and its stylesheet from the app (the build puts it at /assets/katex-<version>/). */
function loadKatex(): Promise<Katex> {
  katex ??= import("katex").then((m) => {
    const k = (m.default ?? m) as Katex;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/assets/katex-${k.version}/katex.min.css`;
    document.head.append(link);
    return k;
  });
  return katex;
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  get estimatedHeight() {
    return this.display ? blockHeight(`math|${this.tex}`, 60) : -1;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math cm-math-display" : "cm-math";
    if (this.display) measureBlock(`math|${this.tex}`, el);
    // The TeX until KaTeX arrives, and if it can't.
    el.textContent = this.tex;
    void loadKatex().then(
      (k) => {
        k.render(this.tex, el, { displayMode: this.display, throwOnError: false, output: "htmlAndMathml" });
        view.requestMeasure();
        if (this.display) measureBlock(`math|${this.tex}`, el);
      },
      () => el.classList.add("cm-math-failed"),
    );
    if (this.display) {
      // A click puts the cursor in it, which shows its TeX to edit.
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: view.posAtDOM(el) }, userEvent: "select.pointer" });
        view.focus();
      });
    }
    return el;
  }
  ignoreEvent() {
    return !this.display;
  }
}

const inline = livePreview((line, view) => {
  const out: Preview[] = [];
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name !== "InlineMath" || node.to > line.to) return;
      const tex = texOf(view.state.doc.sliceString(node.from, node.to), false);
      out.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new MathWidget(tex, false) }) });
    },
  });
  return out;
});

const display = blockPreview((state) => {
  const out: BlockPreview[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "BlockMath") return;
      out.push({ from: node.from, to: node.to, widget: new MathWidget(texOf(state.doc.sliceString(node.from, node.to), true), true) });
      return false;
    },
  });
  return out;
});

const theme = EditorView.theme({
  ".cm-math": { fontFamily: "var(--mono)" },
  ".cm-math .katex": { fontSize: "1.05em" },
  ".cm-math-display": { padding: "0.5em 0", textAlign: "center", cursor: "text", overflowX: "auto" },
  ".cm-math-failed": { color: "var(--muted)" },
});

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.markdown(math);
    ctx.editor.extend([inline, display, theme]);
  },
};
