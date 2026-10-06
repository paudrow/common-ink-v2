// A link to a note that's in Trash says so after it, "In Trash · Restore", instead of leading nowhere.
// [[Name]] links, and markdown links to a .md file.
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { icon } from "common-ink/icons";

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(\s*<?([^)\s>]+\.md)>?(?:#[^)\s]*)?\s*\)/g;

const trashChanged = StateEffect.define<null>();

/** Every editor with links drawn, to draw again when Trash changes. */
const views = new Set<EditorView>();

/** Trash changed: draw every editor's links again. */
export const refreshTrashLinks = () => views.forEach((v) => v.dispatch({ effects: trashChanged.of(null) }));

export interface LinkEnv {
  /** The note a link's target names, if it's in Trash. */
  inTrash(target: string): string | null;
  restore(path: string): void;
}

class InTrash extends WidgetType {
  constructor(
    private path: string,
    private env: LinkEnv,
  ) {
    super();
  }
  eq(other: InTrash) {
    return other.path === this.path;
  }
  toDOM() {
    const box = document.createElement("span");
    box.className = "trash-link";
    box.append(icon("trash-2", 12), "In Trash · ");
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.addEventListener("mousedown", (e) => e.preventDefault());
    restore.addEventListener("click", () => this.env.restore(this.path));
    box.append(restore);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function decorate(view: EditorView, env: LinkEnv): DecorationSet {
  const out = new RangeSetBuilder<Decoration>();
  let drawn = 0;
  const target = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    for (let n = Math.max(doc.lineAt(from).number, drawn + 1); n <= doc.lineAt(to).number; n++) {
      drawn = n;
      const line = doc.line(n);
      for (const m of line.text.matchAll(LINK)) {
        const path = env.inTrash(target(m[1] ?? m[2]));
        if (path) out.add(line.from + m.index + m[0].length, line.from + m.index + m[0].length, Decoration.widget({ widget: new InTrash(path, env), side: 1 }));
      }
    }
  }
  return out.finish();
}

export function trashLinks(env: LinkEnv) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(private view: EditorView) {
        this.decorations = decorate(view, env);
        views.add(view);
      }
      destroy() {
        views.delete(this.view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(trashChanged)))) this.decorations = decorate(u.view, env);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
