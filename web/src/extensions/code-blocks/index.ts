// Code blocks, a built-in extension: fenced code parsed in its language (from @codemirror/language-data,
// each language loaded the first time a block names it) and highlighted. A block reads as a card: a
// header with its language, Wrap and Copy in place of its opening fence, and its closing fence hidden,
// until the cursor is in it, when the fences show. Its code lines are the same either way (Live
// preview styles them), so nothing moves. Wrap follows the code-blocks.wrap setting; a block's Wrap
// button flips it for that block while the note is open.
import { LanguageDescription, ParseContext, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
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

/** The fenced block at `pos`, if `pos` is in one: its node, and its code (the lines between its fences). */
function blockAt(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== "FencedCode") continue;
    const text = n.getChild("CodeText");
    return { node: n, code: text ? state.doc.sliceString(text.from, text.to) : "" };
  }
  // At the end of a line inside a block, the node starts after `pos`; look back too.
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== "FencedCode") continue;
    const text = n.getChild("CodeText");
    return { node: n, code: text ? state.doc.sliceString(text.from, text.to) : "" };
  }
  return null;
}

/**
 * A block's header, in place of its opening fence while the cursor isn't in the block: its language,
 * and Wrap and Copy. It's no taller than the fence's line, so nothing moves when the fence shows instead.
 */
class Header extends WidgetType {
  constructor(
    readonly language: string,
    readonly wraps: boolean,
    readonly copy: (text: string) => Promise<void>,
  ) {
    super();
  }
  eq(other: Header) {
    return other.language === this.language && other.wraps === this.wraps;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-code-header";
    const label = document.createElement("span");
    label.className = "cm-code-lang";
    label.textContent = this.language || "code";
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
    const copy = button("Copy", "Copy this block's code (⌘⇧C)", (b) => {
      // Written in this click, before anything waits: browsers allow it only while handling the click.
      void this.copy(blockAt(view.state, fence())?.code ?? "").then(
        () => (b.textContent = "Copied"),
        () => (b.textContent = "Not copied"),
      );
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
    box.append(label, wrap, copy);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const noWrap = Decoration.line({ class: "cm-code-nowrap" });
const fenceLine = Decoration.line({ class: "cm-code-fence" });
const hide = Decoration.replace({});

const theme = EditorView.theme({
  // As tall as the line it's on, never taller: the fence that shows in its place takes the same line.
  ".cm-code-header": { display: "inline-flex", width: "100%", alignItems: "center", gap: "0.35em", verticalAlign: "top", fontFamily: "var(--prose)", fontSize: "0.7rem", lineHeight: "1.2" },
  ".cm-code-lang": { flex: "1", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: "650", color: "var(--muted)" },
  ".cm-code-header button": { font: "inherit", lineHeight: "1.2", color: "var(--muted)", background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "0 0.45em", cursor: "pointer" },
  ".cm-code-header button:hover": { color: "var(--ink)" },
  ".cm-code-header button[aria-pressed=true]": { color: "var(--ink)" },
  // While you're in the block, its fences show, quietly, in the same lines the header and the end took.
  "& .cm-line.cm-code-fence": { color: "var(--muted)" },
  "& .cm-line.cm-code-nowrap": { whiteSpace: "pre", overflowWrap: "normal" },
});

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.markdown(parseCode({ codeParser }));
    const card = livePreview((line, view) => {
      const out: Preview[] = [];
      const state = view.state;
      syntaxTree(state).iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
          if (node.name !== "FencedCode") return;
          const open = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const closing = last.number > open.number && /^\s*(```|~~~)/.test(last.text) ? last : null;
          const wraps = ctx.settings.get<boolean>("code-blocks.wrap") !== state.field(flipped).has(open.from);
          if (!wraps) out.push({ from: line.from, to: line.from, decoration: noWrap });
          const fence = line.number === open.number || line.number === closing?.number;
          if (fence) out.push({ from: line.from, to: line.from, decoration: fenceLine });
          // The cursor anywhere in the block shows its fences; otherwise it's a card.
          const inside = state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
          if (inside || !fence) return false;
          const indent = /^\s*/.exec(line.text)![0].length;
          if (line.number === open.number) {
            const info = node.node.getChild("CodeInfo");
            const language = info ? state.doc.sliceString(info.from, info.to).split(/\s/)[0] : "";
            out.push({ from: line.from + indent, to: line.to, decoration: Decoration.replace({ widget: new Header(language, wraps, ctx.clipboard.write) }) });
          } else if (line.to > line.from + indent) out.push({ from: line.from + indent, to: line.to, decoration: hide });
          return false;
        },
      });
      return out;
    });
    ctx.editor.extend([flipped, card, codeHighlighting, theme]);
    // ⌘⇧C copies the block the cursor is in, in the keypress.
    ctx.commands.register("code-blocks.copy", () => {
      const view = ctx.editor.focused();
      const block = view && blockAt(view.state, view.state.selection.main.head);
      if (block) void ctx.clipboard.write(block.code);
    });
  },
};
