// Vim, a built-in extension: Vim keys in every editor (codemirror-vim), its mode in the status bar, ex
// commands and key sequences that run the app's commands, and Ctrl-O and Ctrl-I as the app's Go back
// and Go forward, as VSCodeVim does: one history of where you've been, jumps within a note included.
// Every extension's "vim" keybindings are mapped here.
import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import type { FilePath } from "../../../../worker/src/files.ts";
import type { ExtensionContext } from "../../extension-api.ts";
import { insertUndo, modeChanged } from "./undo.ts";

type ExParams = { argString?: string; input?: string };
type CM = NonNullable<ReturnType<typeof getCM>>;
type Pos = { line: number; ch: number };

const theme = EditorView.theme({
  ".cm-vim-panel": { padding: "0.25rem 1rem", fontFamily: "var(--mono)" },
  ".cm-vim-panel input": { color: "var(--ink)", fontFamily: "var(--mono)" },
  ".cm-fat-cursor": { background: "var(--accent) !important", color: "var(--bg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--accent)" },
});

/** Vim's jump list is global and holds positions in the editor that had focus before; in a shorter file
 * the next G or gg throws on them. Each editor starts a fresh jump list, keeping registers and searches. */
function freshJumps() {
  const kept = { ...Vim.getVimGlobalState_() };
  Vim.resetVimGlobalState_();
  const fresh = Vim.getVimGlobalState_();
  Object.assign(fresh, kept, { jumpList: fresh.jumpList });
}

export default {
  activate(ctx: ExtensionContext) {
    const showMode = (mode: string) => ctx.statusBar.set("vim.mode", mode);

    // The mode of the focused editor, in the status bar.
    const modeWatch = ViewPlugin.define((view) => {
      const watch = (cm: CM) =>
        cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
          modeChanged(view, e.mode);
          if (view === ctx.editor.focused()) showMode([e.mode, e.subMode].filter(Boolean).join(" ").toUpperCase());
        });
      const cm = getCM(view);
      if (cm) watch(cm);
      else queueMicrotask(() => getCM(view) && watch(getCM(view)!));
      return {};
    });
    // Before every other keymap, so Vim sees keys first.
    ctx.editor.extend(Prec.highest([insertUndo, vim(), modeWatch, theme]), { everywhere: true });

    // A different editor took focus: it starts in normal mode, with its own jumps.
    let shown: EditorView | null = null;
    ctx.events.onFocus(() => {
      const view = ctx.editor.focused();
      if (view === shown) return;
      shown = view;
      freshJumps();
      showMode("NORMAL");
    });

    // zt, z<CR>, zz, z., zb and z- as Vim's own, set at once (the motion z<CR> runs after would replace
    // a scroll request), but with the line at the top kept below the editor's top scroll margin: clear
    // of the phone's not-saved pill, say. With no margin, they land where Vim's do.
    Vim.defineAction("scrollToCursor", (cm, args) => {
      const view = cm.cm6;
      const line = cm.getCursor().line;
      const at = cm.charCoords({ line, ch: 0 }, "local");
      const height = cm.getScrollInfo().clientHeight;
      const margin = Math.max(0, ...view.state.facet(EditorView.scrollMargins).map((f: (v: EditorView) => { top?: number } | null) => f(view)?.top ?? 0));
      let y = at.top - margin;
      if (args.position === "center") y = at.bottom - height / 2;
      if (args.position === "bottom") y = at.top - height + (cm.charCoords({ line, ch: cm.getLine(line).length - 1 }, "local").bottom - at.top);
      cm.scrollTo(null, y);
    });

    // Ex commands, each the app's command or the workbench's call.
    const exArg = (params: ExParams) => (params.argString ?? "").trim();
    const run = (command: string) => () => void ctx.commands.run(command);
    /** An ex command that opens the note named in its argument, or does something else without one. */
    const exOpen = (name: string, prefix: string, withArg: (path: FilePath) => unknown, without: () => unknown) =>
      Vim.defineEx(name, prefix, (_cm: unknown, params: ExParams) => {
        const arg = exArg(params).replace(/^!\s*/, "");
        const path = arg ? ctx.util.notePathFor(arg) : null;
        if (path) void withArg(path);
        else if (!arg) void without();
      });
    Vim.defineEx("write", "w", run("note.save"));
    Vim.defineEx("edit", "e", (_cm: unknown, params: ExParams) => {
      const arg = exArg(params);
      const force = /^e(dit)?!/.test(params.input ?? "") || arg.startsWith("!");
      const path = ctx.util.notePathFor(arg.replace(/^!\s*/, ""));
      if (path) void ctx.workbench.open(path);
      else if (!arg.replace(/^!\s*/, "") && (force || !ctx.workbench.hasUnsavedChanges())) ctx.commands.run("note.reload");
    });
    Vim.defineEx("quit", "q", run("tab.close"));
    Vim.defineEx("archive", "archive", run("archive.archive"));
    Vim.defineEx("unarchive", "unarchive", run("archive.unarchive"));
    Vim.defineEx("trash", "trash", run("trash.note"));
    Vim.defineEx("close", "clo", run("window.close"));
    Vim.defineEx("only", "on", run("window.only"));
    exOpen("split", "sp", (p) => ctx.workbench.split("down", p), run("window.splitDown"));
    exOpen("vsplit", "vs", (p) => ctx.workbench.split("right", p), run("window.splitRight"));
    exOpen("tabedit", "tabe", (p) => ctx.workbench.open(p, { newTab: true }), run("tab.open"));
    exOpen("tabnew", "tabnew", (p) => ctx.workbench.open(p, { newTab: true }), run("tab.open"));
    Vim.defineEx("tabnext", "tabn", run("tab.next"));
    Vim.defineEx("tabprevious", "tabp", run("tab.previous"));
    Vim.defineEx("tabclose", "tabc", run("tab.close"));
    // :tabmove +1, :tabmove -1, or :tabmove N to put the tab at position N (0 is first).
    Vim.defineEx("tabmove", "tabm", (_cm: unknown, params: ExParams) => {
      const arg = exArg(params);
      const { active, count } = ctx.workbench.tabs();
      ctx.workbench.moveTab(/^[+-]\d+$/.test(arg) ? Number(arg) : /^\d+$/.test(arg) ? Number(arg) - active : arg === "" ? count - 1 - active : 0);
    });

    // Every extension's Vim sequences, this one's included, as normal-mode keys that run their commands.
    // Vim's own Ctrl-W in normal mode does nothing, and as a whole key it would swallow Ctrl-W h and the rest.
    Vim.unmap("<C-w>", "normal");
    for (const { vim: keys, command, operator } of ctx.commands.keybindings()) {
      if (!keys) continue;
      const name = `run:${command}`;
      if (operator) {
        // In place of Vim's own operator: Vim selects what the motion covers (>> a line, >ip a
        // paragraph, or the visual selection), the command acts on the selection, and the cursor stays.
        Vim.defineOperator(name, (cm: CM, _args: unknown, ranges: ReadonlyArray<{ anchor: Pos; head: Pos }>) => {
          const doc = cm.cm6.state.doc;
          ctx.commands.run(command);
          // A command that put the cursor somewhere (a list item moved by the outline's rules) keeps it there.
          if (cm.cm6.state.doc !== doc && cm.cm6.state.selection.main.empty) return cm.getCursor();
          // Nothing changed (the outline's rules refused), or the motion's range is still selected (a
          // plain shift): where Vim leaves a shift, the first line's first non-blank, not past the range.
          const line = Math.min(...ranges.map((r) => Math.min(r.anchor.line, r.head.line)));
          return { line, ch: cm.getLine(line).search(/\S|$/) };
        });
        Vim.mapCommand(keys, "operator", name, {}, {});
        continue;
      }
      Vim.defineAction(name, () => void ctx.commands.run(command));
      Vim.mapCommand(keys, "action", name, {}, { context: "normal" });
    }
  },
};
