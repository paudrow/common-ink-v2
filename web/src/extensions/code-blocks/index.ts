// Code blocks, a built-in extension: fenced code parsed in its language (from @codemirror/language-data,
// each language loaded the first time a block names it) and highlighted, and Copy and Wrap on each
// block's opening line. Wrap follows the code-blocks.wrap setting; a block's Wrap button flips it for
// that block while the note is open.
import { LanguageDescription, ParseContext, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { parseCode } from "@lezer/markdown";
import { livePreview, type Preview } from "common-ink/live-preview";
import type { ExtensionContext } from "../../extension-api.ts";
import { codeHighlighting } from "./highlight.ts";

/** The parser for a block's info string ("python", "js title=x"), or null to leave it plain. */
export function codeParser(info: string) {
  const name = /\S*/.exec(info)?.[0];
  const found = name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
  if (!found) return null;
  // Not loaded yet: skip the block for now; the editor parses it again once the language arrives.
  return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
}

/** Blocks whose wrapping is flipped from the setting, by where their opening fence starts. */
const flip = StateEffect.define<number>();
const flipped = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(blocks, tr) {
    const flips = tr.effects.filter((e) => e.is(flip));
    if (!tr.docChanged && !flips.length) return blocks;
    const next = new Set([...blocks].map((pos) => tr.changes.mapPos(pos, 1)));
    for (const e of flips) {
      if (next.has(e.value)) next.delete(e.value);
      else next.add(e.value);
    }
    return next;
  },
});

/** The block's code: the lines between its fences. */
function codeOf(state: EditorState, fence: number): string {
  const node = syntaxTree(state).resolveInner(fence, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name !== "FencedCode") continue;
    const text = n.getChild("CodeText");
    return text ? state.doc.sliceString(text.from, text.to) : "";
  }
  return "";
}

class Tools extends WidgetType {
  constructor(
    readonly wraps: boolean,
    readonly copy: (text: string) => Promise<void>,
  ) {
    super();
  }
  eq(other: Tools) {
    return other.wraps === this.wraps;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-code-tools";
    const button = (text: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = title;
      // Keep the editor's focus and cursor where they are.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => run(b));
      return b;
    };
    const fence = () => view.state.doc.lineAt(view.posAtDOM(box)).from;
    const wrap = button("Wrap", this.wraps ? "Long lines wrap: press to let them run on" : "Long lines run on: press to wrap them", () => view.dispatch({ effects: flip.of(fence()) }));
    wrap.setAttribute("aria-pressed", String(this.wraps));
    box.append(
      wrap,
      button("Copy", "Copy this block's code", (b) => {
        void this.copy(codeOf(view.state, fence())).then(
          () => (b.textContent = "Copied"),
          () => (b.textContent = "Not copied"),
        );
        setTimeout(() => (b.textContent = "Copy"), 1500);
      }),
    );
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const noWrap = Decoration.line({ class: "cm-code-nowrap" });

const theme = EditorView.theme({
  ".cm-code-tools": { float: "right", display: "inline-flex", gap: "0.25em", fontFamily: "var(--prose)", fontSize: "0.75rem" },
  ".cm-code-tools button": { font: "inherit", color: "var(--muted)", background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "0 0.4em", cursor: "pointer" },
  ".cm-code-tools button:hover": { color: "var(--ink)" },
  ".cm-code-tools button[aria-pressed=true]": { color: "var(--ink)", backgroundColor: "var(--code-bg)" },
  "& .cm-line.cm-code-nowrap": { whiteSpace: "pre", overflowWrap: "normal" },
});

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.markdown(parseCode({ codeParser }));
    const tools = livePreview((line, view) => {
      const out: Preview[] = [];
      syntaxTree(view.state).iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
          if (node.name !== "FencedCode") return;
          const open = view.state.doc.lineAt(node.from);
          const wraps = ctx.settings.get<boolean>("code-blocks.wrap") !== view.state.field(flipped).has(open.from);
          if (!wraps) out.push({ from: line.from, to: line.from, decoration: noWrap });
          if (open.number === line.number) out.push({ from: line.to, to: line.to, decoration: Decoration.widget({ widget: new Tools(wraps, ctx.clipboard.write), side: 1 }) });
          return false;
        },
      });
      return out;
    });
    ctx.editor.extend([flipped, tools, codeHighlighting, theme]);
  },
};
