// Lists, a built-in extension: lists edited as an outliner edits them (model.ts, edit.ts) and drawn as
// they read (preview.ts). Keys: Tab and Shift-Tab, or Alt-Right and Alt-Left (declared, so you can bind
// them elsewhere; off a list they do what they would have), Alt-Up and Alt-Down, and Enter on an empty
// item; for Vim, >> and << (and > and < on a selection), [e and ]e, and za. An indent the rules refuse
// says why in the status bar, for a moment.
import { indentLess, indentMore } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";
import { convertItems, dedentItems, enterOnEmptyItem, folding, indentItems, moveItem, renumberOnEdit, toggleFold } from "./edit.ts";
import { listPreview, listTheme } from "./preview.ts";

export default {
  activate(ctx: ExtensionContext) {
    // Why an indent or dedent didn't happen, in the status bar, gone after a moment.
    let quiet = 0;
    const say = (why: string) => {
      ctx.statusBar.set("lists.message", why);
      clearTimeout(quiet);
      quiet = window.setTimeout(() => ctx.statusBar.set("lists.message", ""), 2500);
    };
    const indent = (view: EditorView) => indentItems(view, say);
    const dedent = (view: EditorView) => dedentItems(view, say);
    ctx.editor.extend([
      // Before markdown's own Enter, which continues a list; this one only steps out of an empty item.
      Prec.high(
        keymap.of([
          { key: "Tab", run: indent },
          { key: "Shift-Tab", run: dedent },
          { key: "Alt-ArrowUp", run: (view) => moveItem(view, -1) },
          { key: "Alt-ArrowDown", run: (view) => moveItem(view, 1) },
          { key: "Enter", run: enterOnEmptyItem },
        ]),
      ),
      renumberOnEdit,
      folding,
      listPreview,
      listTheme,
    ]);
    /** A command on the focused editor; off a list, `otherwise` (Vim's >> on a plain line still indents it). */
    const onEditor = (run: (view: EditorView) => boolean, otherwise?: (view: EditorView) => boolean) => () => {
      const view = ctx.editor.focused();
      if (view && !run(view)) otherwise?.(view);
    };
    ctx.commands.register("lists.indent", onEditor(indent, indentMore));
    ctx.commands.register("lists.dedent", onEditor(dedent, indentLess));
    // Alt-Right and Alt-Left: on a list item, indent and dedent it; anywhere else, false, so the key does what it would have.
    const onItem = (run: (view: EditorView) => boolean) => () => {
      const view = ctx.editor.focused();
      return !!view && run(view);
    };
    ctx.commands.register("lists.indentItem", onItem(indent));
    ctx.commands.register("lists.dedentItem", onItem(dedent));
    ctx.commands.register("lists.moveUp", onEditor((view) => moveItem(view, -1)));
    ctx.commands.register("lists.moveDown", onEditor((view) => moveItem(view, 1)));
    ctx.commands.register("lists.toBullets", onEditor((view) => convertItems(view, "bullet")));
    ctx.commands.register("lists.toNumbers", onEditor((view) => convertItems(view, "number")));
    ctx.commands.register("lists.toTasks", onEditor((view) => convertItems(view, "task")));
    ctx.commands.register("lists.toggleFold", onEditor(toggleFold));
  },
};
