// Lists as they read (on the live-preview mechanism): real bullets that change with depth, numbers
// right-aligned in their column, text that hangs past its marker when it wraps, and a faint guide for
// each level. A bullet with folded children has a ring; pressing a bullet folds or unfolds them. The
// line the cursor is on shows its markdown. Todos' boxes are the Todos extension's.
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { livePreview, revealedLines, type Preview } from "common-ink/live-preview";
import { isFolded, toggleFoldAt } from "./edit.ts";
import * as M from "./model.ts";

const BULLETS = ["•", "◦", "▪"];

class BulletWidget extends WidgetType {
  constructor(
    readonly depth: number,
    readonly folded: boolean,
    readonly parent: boolean,
  ) {
    super();
  }
  eq(other: BulletWidget) {
    return other.depth === this.depth && other.folded === this.folded && other.parent === this.parent;
  }
  toDOM(view: EditorView) {
    const bullet = document.createElement("span");
    bullet.className = `cm-list-bullet${this.folded ? " folded" : ""}${this.parent ? " parent" : ""}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = BULLETS[this.depth % BULLETS.length];
    bullet.append(dot);
    if (this.parent) {
      bullet.title = this.folded ? "Unfold" : "Fold";
      bullet.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        toggleFoldAt(view, view.state.doc.lineAt(view.posAtDOM(bullet)).number - 1);
      });
    }
    return bullet;
  }
  ignoreEvent() {
    return this.parent;
  }
}

class NumberWidget extends WidgetType {
  constructor(readonly marker: string) {
    super();
  }
  eq(other: NumberWidget) {
    return other.marker === this.marker;
  }
  toDOM() {
    const n = document.createElement("span");
    n.className = "cm-list-number";
    n.textContent = this.marker;
    return n;
  }
}

const hide = Decoration.replace({});

/** How deep a list node is: 0 for a top-level item. */
function depthOf(node: { parent: { name: string; parent: unknown } | null }): number {
  let depth = -1;
  for (let n = node.parent as { name: string; parent: unknown } | null; n; n = n.parent as typeof n) if (n.name === "BulletList" || n.name === "OrderedList") depth++;
  return Math.max(depth, 0);
}

export const listPreview = livePreview((line, view) => {
  if (revealedLines(view).has(line.number)) return [];
  const out: Preview[] = [];
  const state = view.state;
  const indent = /^[ \t]*/.exec(line.text)![0].length;
  const item = M.parseItem(line.text);
  // The list node the line's text is in: its item's mark, or the paragraph it continues.
  const node = syntaxTree(state).resolveInner(line.from + indent, 1);
  let listItem: typeof node | null = node;
  while (listItem && listItem.name !== "ListItem") listItem = listItem.parent;
  if (!listItem) return out;
  const depth = depthOf(listItem);
  const style = (cls: string) => Decoration.line({ class: cls, attributes: { style: `--list-depth: ${depth}` } });
  if (indent) out.push({ from: line.from, to: line.from + indent, decoration: hide });
  if (!item || state.doc.lineAt(listItem.from).number !== line.number) {
    // A line of an item's text after its first.
    out.push({ from: line.from, to: line.from, decoration: style("cm-list-cont") });
    return out;
  }
  out.push({ from: line.from, to: line.from, decoration: style("cm-list-line") });
  const markEnd = line.from + item.markerEnd;
  if (item.kind === "number") out.push({ from: line.from + indent, to: markEnd, decoration: Decoration.replace({ widget: new NumberWidget(item.marker) }) });
  else if (item.kind === "bullet") {
    const i = line.number - 1;
    const parent = M.subtreeEnd(state.doc.toString().split("\n"), i) > i + 1;
    out.push({ from: line.from + indent, to: markEnd, decoration: Decoration.replace({ widget: new BulletWidget(depth, parent && isFolded(state, i), parent) }) });
  }
  return out;
});

const UNIT = "1.6em";
const guides = (levels: string) => ({
  backgroundImage: `repeating-linear-gradient(to right, transparent 0 0.75em, var(--line) 0.75em calc(0.75em + 1px), transparent calc(0.75em + 1px) ${UNIT})`,
  backgroundSize: `calc(${levels} * ${UNIT}) 100%`,
  backgroundRepeat: "no-repeat",
});

export const listTheme = EditorView.theme({
  // The hanging indent is the line's own. Inline boxes inside it (a todo's box, its chips, math)
  // would take it too and draw their content a column to the left of themselves.
  ".cm-line.cm-list-line *": { textIndent: "0" },
  ".cm-line.cm-list-line": { paddingLeft: `calc((var(--list-depth) + 1) * ${UNIT})`, textIndent: `calc(-1 * ${UNIT})`, ...guides("var(--list-depth)") },
  ".cm-line.cm-list-cont": { paddingLeft: `calc((var(--list-depth) + 1) * ${UNIT})`, ...guides("(var(--list-depth) + 1)") },
  ".cm-list-bullet": { display: "inline-block", width: UNIT, textIndent: "0", textAlign: "center", color: "var(--muted)" },
  ".cm-list-bullet.parent": { cursor: "pointer" },
  ".cm-list-bullet .dot": { display: "inline-block", minWidth: "1.1em", lineHeight: "1.1em", borderRadius: "50%" },
  ".cm-list-bullet.folded .dot": { backgroundColor: "var(--line)", color: "var(--ink)" },
  ".cm-list-number": { display: "inline-block", width: UNIT, textIndent: "0", textAlign: "right", paddingRight: "0.35em", boxSizing: "border-box", fontVariantNumeric: "tabular-nums", color: "var(--muted)" },
  ".cm-list-folded": { margin: "0 0.35em", padding: "0 0.3em", borderRadius: "4px", color: "var(--muted)", backgroundColor: "var(--code-bg)", cursor: "pointer" },
});
