// GFM tables, drawn as tables: a block preview (common-ink/live-preview) that stands in for a table's
// lines until the cursor is in it. Cells keep their inline formatting: bold, italics, code, links.
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { BlockPreview } from "common-ink/live-preview";

type Align = "left" | "center" | "right" | "";

/** A cell's text, with its inline formatting as elements. */
function inline(node: SyntaxNode, doc: string): Node[] {
  const out: Node[] = [];
  let at = node.from;
  const text = (to: number) => {
    if (to > at) out.push(document.createTextNode(doc.slice(at, to)));
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    text(child.from);
    at = child.to;
    const tag = { StrongEmphasis: "strong", Emphasis: "em", Strikethrough: "s", InlineCode: "code", Link: "a" }[child.name];
    if (tag) {
      const el = document.createElement(tag);
      el.append(...inline(child, doc));
      if (tag === "a") {
        const url = child.getChild("URL");
        if (url) el.setAttribute("data-href", doc.slice(url.from, url.to));
        el.className = "cm-md-link";
      }
      out.push(el);
    } else if (!/Mark$|^URL$|^LinkLabel$/.test(child.name)) out.push(...inline(child, doc));
  }
  text(node.to);
  return out;
}

const alignOf = (cell: string): Align => {
  const c = cell.trim();
  return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "";
};

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly build: () => HTMLTableElement) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-gfm-table";
    box.append(this.build());
    // A click puts the cursor in the table, which shows its markdown to edit.
    box.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".cm-md-link") && (e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** Every table in the document, as a widget. */
export function tables(state: EditorState): BlockPreview[] {
  const doc = state.doc.toString();
  const out: BlockPreview[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const table = node.node;
      const delimiter = table.getChildren("TableDelimiter").find((d) => d.to - d.from > 1);
      const aligns = delimiter ? doc.slice(delimiter.from, delimiter.to).replace(/^\||\|$/g, "").split("|").map(alignOf) : [];
      const build = () => {
        const el = document.createElement("table");
        for (const row of [...table.getChildren("TableHeader"), ...table.getChildren("TableRow")]) {
          const tr = document.createElement("tr");
          row.getChildren("TableCell").forEach((cell, i) => {
            const td = document.createElement(row.name === "TableHeader" ? "th" : "td");
            if (aligns[i]) td.style.textAlign = aligns[i];
            td.append(...inline(cell, doc));
            tr.append(td);
          });
          (row.name === "TableHeader" ? (el.tHead ?? el.createTHead()) : (el.tBodies[0] ?? el.createTBody())).append(tr);
        }
        return el;
      };
      out.push({ from: node.from, to: node.to, widget: new TableWidget(doc.slice(node.from, node.to), build) });
      return false;
    },
  });
  return out;
}

export const tableTheme = EditorView.theme({
  ".cm-gfm-table": { padding: "0.25em 0", overflowX: "auto", cursor: "text" },
  ".cm-gfm-table table": { borderCollapse: "collapse", fontSize: "0.95em" },
  ".cm-gfm-table th, .cm-gfm-table td": { border: "1px solid var(--line)", padding: "0.25em 0.6em", textAlign: "left", verticalAlign: "top" },
  ".cm-gfm-table th": { fontWeight: "650", backgroundColor: "var(--code-bg)" },
  ".cm-gfm-table code": { fontFamily: "var(--mono)", fontSize: "0.9em" },
});
