// Words, a built-in extension: the focused note's word count in the status bar, as you type. It counts
// only while the count can be seen: the status bar showing (a phone has none) and a note in focus. An
// edit reads again only the lines it touched.
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";
import { WordTally } from "./count.ts";

const number = new Intl.NumberFormat();

/**
 * Run a count as a performance measure, "Words: count", with how many lines it read in its detail, so
 * a profile or a test tells Words' work from the rest. Only the latest stays in the timeline; a
 * PerformanceObserver sees each.
 */
function measure(count: () => number): void {
  const start = performance.now();
  const lines = count();
  performance.clearMeasures("Words: count");
  performance.measure("Words: count", { start, detail: { lines } });
}

export default {
  activate(ctx: ExtensionContext) {
    const tallies = new WeakMap<EditorView, WordTally>();
    let shown = false;
    let said = "";
    const say = (text: string) => {
      if (text !== said) ctx.statusBar.set("words.count", (said = text));
    };
    /** The editor whose words show, if they show. */
    const counted = () => {
      const view = ctx.editor.focused();
      return shown && view && ctx.workbench.focusedPath()?.endsWith(".md") ? view : null;
    };
    const show = () => {
      const view = counted();
      if (!view) return say("");
      const doc = view.state.doc;
      // Counted afresh only when its text changed while it wasn't counted: opened, or edited from elsewhere out of focus.
      if (tallies.get(view)?.doc !== doc)
        measure(() => {
          tallies.set(view, new WordTally(doc));
          return doc.lines;
        });
      const total = tallies.get(view)!.total;
      say(`${number.format(total)} ${total === 1 ? "word" : "words"}`);
    };
    // Focus moves before the note's editor is there: shown once it is.
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(show, 50);
    };
    ctx.editor.extend(
      ViewPlugin.define((view) => {
        later();
        return {
          update(u) {
            if (!u.docChanged || counted() !== view) return;
            const tally = tallies.get(view);
            if (tally?.doc === u.startState.doc) measure(() => tally.update(u.changes, u.state.doc));
            show();
          },
        };
      }),
    );
    ctx.events.onFocus(later);
    ctx.statusBar.onShown((s) => {
      shown = s;
      later();
    });
  },
};
