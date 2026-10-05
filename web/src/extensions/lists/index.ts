// Lists, a built-in extension: lists edited as an outliner edits them (model.ts, edit.ts) and drawn as
// they read (preview.ts). Keys: Tab and Shift-Tab, Alt-Up and Alt-Down, and Enter on an empty item;
// for Vim, >> and << (and > and < on a selection), [e and ]e, and za.
import { indentLess, indentMore } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";
import { convertItems, dedentItems, enterOnEmptyItem, folding, indentItems, moveItem, renumberOnEdit, toggleFold } from "./edit.ts";
import { listPreview, listTheme } from "./preview.ts";

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.extend([
      // Before markdown's own Enter, which continues a list; this one only steps out of an empty item.
      Prec.high(
        keymap.of([
          { key: "Tab", run: indentItems },
          { key: "Shift-Tab", run: dedentItems },
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
    ctx.commands.register("lists.indent", onEditor(indentItems, indentMore));
    ctx.commands.register("lists.dedent", onEditor(dedentItems, indentLess));
    ctx.commands.register("lists.moveUp", onEditor((view) => moveItem(view, -1)));
    ctx.commands.register("lists.moveDown", onEditor((view) => moveItem(view, 1)));
    ctx.commands.register("lists.toBullets", onEditor((view) => convertItems(view, "bullet")));
    ctx.commands.register("lists.toNumbers", onEditor((view) => convertItems(view, "number")));
    ctx.commands.register("lists.toTodos", onEditor((view) => convertItems(view, "todo")));
    ctx.commands.register("lists.toggleFold", onEditor(toggleFold));
  },
};
