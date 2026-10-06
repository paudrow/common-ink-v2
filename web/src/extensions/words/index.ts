// Words, a built-in extension: the focused note's word count in the status bar, as you type. The core
// hides the status bar on a phone, so it shows on wider screens only.
import { ViewPlugin } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";
import { countWords } from "./count.ts";

const number = new Intl.NumberFormat();

export default {
  activate(ctx: ExtensionContext) {
    let timer = 0;
    const show = () => {
      const view = ctx.editor.focused();
      const n = view ? countWords(view.state.doc.toString()) : null;
      ctx.statusBar.set("words.count", n === null ? "" : `${number.format(n)} ${n === 1 ? "word" : "words"}`);
    };
    // Counted a moment after typing stops, so a long note doesn't slow typing down.
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(show, 150);
    };
    ctx.editor.extend(
      ViewPlugin.define(() => {
        later();
        return { update: (u) => void (u.docChanged && later()) };
      }),
    );
    ctx.events.onFocus(later);
    later();
  },
};
