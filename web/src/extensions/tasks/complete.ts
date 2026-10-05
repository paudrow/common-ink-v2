// Completions for a task's tokens as you type them: `due:` and `start:` offer days, `rec:` offers
// repeats, `!` a priority, `@` the people already on tasks and `#` the tags in use. Only in a task's
// text, never in code. "Pick a date…" and "More options…" open that field's editor where the cursor is.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { el } from "./dom.ts";
import { inTaskText } from "./edit.ts";
import { openFieldEditor, REPEAT_PICKS, type MenuField } from "./editors.ts";
import { addDays } from "./tasks.ts";
import { lineTaskContext, type TaskEnv } from "./widgets.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Days to offer after `due:` or `start:`, counted from `today`: today, tomorrow, the rest of the coming week, next week. */
export function dayPicks(today: string): Array<{ label: string; date: string }> {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    ...[2, 3, 4, 5, 6].map((n) => ({ label: `Next ${WEEKDAYS[(weekday + n) % 7]}`, date: addDays(today, n) })),
    { label: "Next week", date: addDays(today, 7) },
  ];
}

/** Open one field's editor for the task at `pos`, under the cursor. */
function openFieldAt(view: EditorView, env: TaskEnv, field: MenuField, pos: number, opts?: { more?: boolean }) {
  const ctx = lineTaskContext(view, view.state.doc.lineAt(pos).number, env);
  const at = view.coordsAtPos(pos);
  if (!ctx || !at) return;
  // The editors open under an element; a one-pixel one where the cursor is stands in for a chip.
  const anchor = el("span", { style: { position: "fixed", left: `${at.left}px`, top: `${at.top}px`, width: "1px", height: `${at.bottom - at.top}px` } });
  document.body.append(anchor);
  openFieldEditor(field, anchor, "", ctx, opts);
  anchor.remove();
}

/** "Pick a date…" and "More options…": take the half-typed token out and open that field's editor there. */
const openEditor = (env: TaskEnv, field: MenuField, tokenFrom: number, opts?: { more?: boolean }) => (view: EditorView, _c: Completion, _from: number, to: number) => {
  // At the end of the line, the space typed before the token goes too: the editor writes the token back in its place.
  const line = view.state.doc.lineAt(tokenFrom);
  const space = view.state.sliceDoc(to, line.to).trim() ? 0 : view.state.sliceDoc(line.from, tokenFrom).match(/[ \t]*$/)![0].length;
  const cut = tokenFrom - space;
  view.dispatch({ changes: { from: cut, to }, selection: { anchor: cut }, userEvent: "input.complete" });
  openFieldAt(view, env, field, cut, opts);
};

/** The completion source for task tokens. */
export function taskTokenSource(env: TaskEnv) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const typed = ctx.matchBefore(/(?<!\S)(?:(due|start|scheduled|rec):\S*|![a-z]*|[@#][\p{L}\p{N}_/.-]*)$/iu);
    if (!typed || !inTaskText(ctx.state, typed.from)) return null;
    const sigil = typed.text[0];
    if (sigil === "@" || sigil === "#") {
      const pool = await (sigil === "@" ? env.people() : env.tags());
      return { from: typed.from + 1, validFor: /^[\p{L}\p{N}_/.-]*$/u, options: pool.map((p, i) => ({ label: p, detail: sigil === "@" ? "person" : "tag", boost: -i })) };
    }
    const key = typed.text.match(/^(\w+):/)?.[1].toLowerCase();
    if (!key) return { from: typed.from, validFor: /^![a-z]*$/i, options: [{ label: "!high", detail: "High priority" }, { label: "!low", detail: "Low priority" }] };
    const from = typed.from + key.length + 1;
    if (key === "rec") {
      return {
        from,
        validFor: /^\S*$/,
        options: [...REPEAT_PICKS.map(([label, rec], i) => ({ label, detail: rec, apply: rec, boost: -i })), { label: "More options…", apply: openEditor(env, "rec", typed.from, { more: true }), boost: -99 }],
      };
    }
    const field = key === "due" ? "due" : "start";
    return {
      from,
      validFor: /^\S*$/,
      options: [...dayPicks(env.today()).map((d, i) => ({ label: d.label, detail: d.date, apply: d.date, boost: -i })), { label: "Pick a date…", apply: openEditor(env, field, typed.from), boost: -99 }],
    };
  };
}

/** Completions for task tokens in note editors. */
export function taskCompletions(env: TaskEnv) {
  return [EditorState.languageData.of(() => [{ autocomplete: taskTokenSource(env) }]), autocompletion({ icons: false })];
}
