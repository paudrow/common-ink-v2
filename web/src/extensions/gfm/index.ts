// GFM, a built-in extension: GitHub Flavored Markdown's syntax added to the markdown language notes are
// parsed with (tables, strikethrough, task lists, bare links), tables drawn as tables, and bare links
// drawn as links. Strikethrough's markers are hidden by Live preview, like emphasis's.
import { foldNodeProp, syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { blockPreview, livePreview, type Preview } from "common-ink/live-preview";
import type { ExtensionContext } from "../../extension-api.ts";
import { tables, tableTheme } from "./tables.ts";

/** A bare address the GFM parser found (not one in a [link](…) or <…>), as a link. */
const bareLinks = livePreview((line, view) => {
  const out: Preview[] = [];
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "Link" || node.name === "Image" || node.name === "Autolink" || node.name === "FencedCode" || node.name === "InlineCode") return false;
      if (node.name !== "URL") return;
      const href = view.state.doc.sliceString(node.from, node.to);
      out.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: "cm-md-link", attributes: { "data-href": href, title: `${href} (⌘-click or gd to follow)` } }) });
    },
  });
  return out;
});

export default {
  activate(ctx: ExtensionContext) {
    // A table folds to its first line, as lang-markdown's GFM language has it.
    ctx.editor.markdown([GFM, { props: [foldNodeProp.add({ Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }) })] }]);
    ctx.editor.extend([blockPreview(tables), bareLinks, tableTheme]);
  },
};
