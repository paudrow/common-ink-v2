// Markdown as it reads, on the live-preview mechanism (live-preview.ts): headings at size without
// their #, emphasis, strikethrough and inline code without their markers, links as their text, wiki
// links as their name, uploaded images as images, and rules, quotes and code blocks styled. Inline
// markup shows its raw markdown while the cursor is on it (that bold, that link), and a heading's #
// while the cursor is on its line.
import { syntaxTree } from "@codemirror/language";
import type { Line } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { livePreview, type Preview } from "common-ink/live-preview";

const hide = Decoration.replace({});
const linkMark = (href: string) => Decoration.mark({ class: "cm-md-link", attributes: { "data-href": href, title: `${href} (⌘-click or gd to follow)` } });
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const codeLine = Decoration.line({ class: "cm-md-codeblock" });
const codeFirst = Decoration.line({ class: "cm-md-codeblock cm-md-codeblock-first" });
const codeLast = Decoration.line({ class: "cm-md-codeblock cm-md-codeblock-last" });

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-md-hr";
    return hr;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    return img;
  }
}

const rule = Decoration.replace({ widget: new RuleWidget() });

/** Wiki links, [[Name]] and [[Name|shown text]]: the markdown parser doesn't know them. */
const WIKI = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;

/** Only images from this site show: the page's Content Security Policy keeps out others. */
const showsAsImage = (src: string) => src.startsWith("/");

/** What a line of markdown draws. Exported for tests. */
export function markdownPreviews(line: Line, view: EditorView): Preview[] {
  const out: Preview[] = [];
  const doc = view.state.doc;
  const at = (from: number, to: number, decoration: Decoration, span?: { from: number; to: number }) => out.push({ from, to, decoration, ...(span ? { span } : {}) });
  let inCode = false;
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      switch (node.name) {
        case "FencedCode":
        case "CodeBlock": {
          // Code stays raw, monospaced, on a background: nothing in it is markdown.
          const first = doc.lineAt(node.from).number === line.number;
          const last = doc.lineAt(node.to).number === line.number;
          at(line.from, line.from, first ? codeFirst : last ? codeLast : codeLine);
          inCode = true;
          return false;
        }
        case "Blockquote":
          at(line.from, line.from, quoteLine);
          return;
        case "QuoteMark":
          if (node.from >= line.from) at(node.from, Math.min(line.to, node.to + (doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0)), hide);
          return;
        case "HeaderMark":
          // The # and the space after it; the text keeps its heading size.
          if (node.from === line.from || /^\s*$/.test(doc.sliceString(line.from, node.from))) {
            at(node.from, Math.min(line.to, node.to + (doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0)), hide);
          }
          return;
        case "EmphasisMark":
        case "StrikethroughMark":
        case "CodeMark": {
          // Its markers show while the cursor is in what they mark: **bold**, ~~gone~~, `code`.
          const marked = node.node.parent;
          if (node.to <= line.to && node.from >= line.from) at(node.from, node.to, hide, marked ? { from: marked.from, to: marked.to } : undefined);
          return;
        }
        case "HorizontalRule":
          at(node.from, node.to, rule);
          return false;
        case "Image": {
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (!url || marks.length < 2 || node.to > line.to) return false;
          const src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
          const alt = doc.sliceString(marks[0].to, marks[1].from);
          const image = { from: node.from, to: node.to };
          if (showsAsImage(src)) at(node.from, node.to, Decoration.replace({ widget: new ImageWidget(src, alt) }), image);
          else {
            at(node.from, marks[0].to, hide, image);
            at(marks[0].to, marks[1].from, linkMark(src), image);
            at(marks[1].from, node.to, hide, image);
          }
          return false;
        }
        case "Link": {
          // [text](url): the text, as a link. A reference link, [text] alone, stays as it is.
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (!url || marks.length < 2 || node.to > line.to) return false;
          const href = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
          const link = { from: node.from, to: node.to };
          at(node.from, marks[0].to, hide, link);
          at(marks[0].to, marks[1].from, linkMark(href), link);
          at(marks[1].from, node.to, hide, link);
          return false;
        }
      }
    },
  });
  if (inCode) return out;
  for (const m of line.text.matchAll(WIKI)) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    // [[Name]] shows "Name"; [[Name|text]] shows "text". Either way it links to Name.
    const textFrom = m[2] === undefined ? from + 2 : from + 3 + m[1].length;
    const wiki = { from, to };
    at(from, textFrom, hide, wiki);
    at(textFrom, to - 2, linkMark(m[1].trim()), wiki);
    at(to - 2, to, hide, wiki);
  }
  return out;
}

const theme = EditorView.theme({
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textDecorationColor: "var(--accent-soft)", textUnderlineOffset: "0.2em", cursor: "pointer" },
  ".cm-md-quote": { borderLeft: "3px solid var(--line)", paddingLeft: "0.75em !important", color: "var(--muted)" },
  ".cm-md-codeblock": { fontFamily: "var(--mono)", fontSize: "0.9em", backgroundColor: "var(--code-bg)", padding: "0 0.75em !important" },
  ".cm-md-codeblock-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px", paddingTop: "0.25em !important" },
  ".cm-md-codeblock-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px", paddingBottom: "0.25em !important" },
  ".cm-md-hr": { display: "inline-block", width: "100%", verticalAlign: "middle", borderTop: "1px solid var(--line)" },
  ".cm-md-image": { display: "block", maxWidth: "100%", maxHeight: "24rem", margin: "0.25em 0", borderRadius: "4px" },
});

/** The markdown live preview, for note editors. */
export const markdownPreview = [livePreview(markdownPreviews), theme];
