// The one place a task is typed: the quick-add bar and a task row's inline edit both use this. Phrases the quick-add parser reads ("tomorrow",
// "every month on the 1st") light up as you type and the chips under it show what will be written;
// a click on a lit phrase keeps it as words. `#`, `@` and `[[` suggest tags, people and notes. It's
// a small CodeMirror, with Vim when the app's Vim setting is on: then it opens in insert mode, Esc
// goes to normal mode and Esc again leaves, and Enter works from either mode.
import { autocompletion, completionStatus, insertCompletionText, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { insertNewline } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { endTags, metaChips, today } from "./chips.ts";
import { el } from "./dom.ts";
import { parseQuickAdd, type QuickAdd, type QuickSpan } from "./quickadd.ts";

/** The same words wherever a task is typed. */
export const PLACEHOLDER = "Add a task…";
export const HINT = 'Try "Pay rent every month on the 1st #home" or "Call mom tomorrow"';

/** Whether task inputs type with Vim keys (the extension sets it from the note editor's), and where `#`, `@` and `[[` get their suggestions. */
export const taskInputPrefs = {
  vim: false,
  sources: { tags: async (): Promise<string[]> => [], people: async (): Promise<string[]> => [], notes: async (): Promise<string[]> => [] },
};

export interface TaskInputOptions {
  /** The text it opens with. Phrases already in it stay words; only what's typed is read. */
  value?: string;
  placeholder?: string;
  /** Vim keys (default: the app's setting). */
  vim?: boolean;
  /** Shift+Enter starts a line nested under it (a card's details); phrases are read on the first line. */
  multiline?: boolean;
  /** Sized to sit in a row or a card; the preview shows only while something's read. */
  compact?: boolean;
  /** Read `→ [[Note]]` as where it goes (the quick-add bar). */
  targets?: boolean;
  /** The preview's "→ …": where it will go, or null to leave it out. */
  where?(parsed: QuickAdd): string | null;
  /** Enter: the text as typed, and the phrases clicked back into words. */
  submit(text: string, ignore: string[]): unknown;
  /** Esc (with Vim, Esc in normal mode). */
  cancel(): void;
  /** Focus left the field (the inline edit saves). */
  blur?(): void;
  /** Tab while typing, with no suggestion list open; true if the host used it. */
  tab?(): boolean;
  /** The text changed (a key, a paste, a suggestion). */
  typed?(): void;
  /** What the preview says while nothing's typed (default: the hint). */
  idle?(): Node | string;
}

export interface TaskInput {
  /** The field. */
  dom: HTMLElement;
  /** The line under it: the words, the chips, and where it goes. */
  preview: HTMLElement;
  focus(): void;
  value(): string;
  clear(): void;
  ignore(): string[];
  parsed(): QuickAdd | null;
  /** Redraw the highlights and preview (the host's `where` changed). */
  render(): void;
  destroy(): void;
}

const setSpans = StateEffect.define<QuickSpan[]>();
/** The lit phrases, as decorations: drawn by the input, never part of what's typed. */
const spansField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setSpans)) return Decoration.set(e.value.map((s) => Decoration.mark({ class: `qa-hl is-${s.kind}` }).range(s.from, s.to)));
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** What `#`, `@` and `[[` suggest, loaded when a field takes focus. */
const pools = { tags: [] as string[], people: [] as string[], notes: [] as string[] };
function loadPools() {
  const { sources } = taskInputPrefs;
  void sources.tags().then((t) => (pools.tags = t)).catch(() => {});
  void sources.people().then((p) => (pools.people = p)).catch(() => {});
  void sources.notes().then((n) => (pools.notes = n)).catch(() => {});
}

function suggest(ctx: CompletionContext): CompletionResult | null {
  const link = ctx.matchBefore(/\[\[[^\]\n]*$/);
  if (link) {
    const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]";
    return { from: link.from + 2, options: pools.notes.map((n) => ({ label: n, detail: "note", apply: (view, _c, from, to) => view.dispatch(insertCompletionText(view.state, closed ? n : `${n}]]`, from, to)) })) };
  }
  const m = ctx.matchBefore(/(?:^|\s)[#@][\p{L}\p{N}_/.-]*$/u);
  if (!m) return null;
  const at = m.from + m.text.search(/[#@]/);
  const sigil = ctx.state.sliceDoc(at, at + 1);
  const pool = sigil === "#" ? pools.tags : pools.people;
  return { from: at + 1, options: pool.map((p, i) => ({ label: p, detail: sigil === "#" ? "tag" : "person", boost: -i, apply: `${p} ` })) };
}

/** A task input; put `dom` and `preview` where the host wants them. */
export function taskInput(opts: TaskInputOptions): TaskInput {
  const useVim = opts.vim ?? taskInputPrefs.vim;
  const phrase = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  const opening = opts.value?.split("\n")[0] ?? "";
  const ignore = new Set(parseQuickAdd(opening, today(), [], { targets: !!opts.targets }).spans.map((s) => phrase(opening.slice(s.from, s.to))));
  const preview = el("div", { class: "qa-preview", "aria-live": "polite" });
  let parsed: QuickAdd | null = null;
  const firstLine = () => view.state.doc.line(1).text;

  const inNormal = (v: EditorView) => {
    if (!useVim) return false;
    const state = getCM(v)?.state.vim as { insertMode?: boolean; visualMode?: boolean } | undefined;
    return !!state && !state.insertMode && !state.visualMode;
  };
  const render = () => {
    const text = firstLine();
    parsed = text.trim() ? parseQuickAdd(text, today(), [...ignore], { targets: !!opts.targets }) : null;
    view.dispatch({ effects: setSpans.of(parsed?.spans ?? []) });
    if (!parsed) {
      preview.hidden = !!opts.compact;
      preview.replaceChildren(opts.idle?.() ?? el("span", { class: "qa-hint" }, HINT));
      return;
    }
    const where = opts.where?.(parsed) ?? null;
    const chips = metaChips(parsed.meta, false, endTags(parsed.words, parsed.meta.tags));
    preview.hidden = !!opts.compact && !chips.length && !where;
    preview.replaceChildren(
      el("span", { class: "qa-words" }, parsed.words || el("em", {}, "Say what the task is")),
      ...chips,
      where ? el("span", { class: "qa-where" }, "→ ", where) : "",
    );
  };

  const view = new EditorView({
    doc: opts.value ?? "",
    extensions: [
      useVim ? vim() : [],
      opts.multiline ? [] : EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)), // one line: Enter submits, it never breaks the line
      Prec.highest(
        EditorView.domEventHandlers({
          // Ahead of Vim's own keys: Enter submits from any mode, Tab is the host's while typing, and
          // Esc leaves (with Vim: from normal mode; in insert mode it's Vim's, back to normal mode).
          keydown: (e, v) => {
            e.stopPropagation(); // the page's own keys stay out of the field
            if (completionStatus(v.state) === "active") return false; // Enter, Tab and Esc are the suggestions' then
            const take = () => (e.preventDefault(), true);
            if (e.key === "Enter" && e.shiftKey && opts.multiline) return false; // Shift+Enter: a nested line
            if (e.key === "Enter") return void opts.submit(v.state.doc.toString(), [...ignore]), take();
            if (e.key === "Tab" && !e.shiftKey && !inNormal(v) && opts.tab?.()) return take();
            if (e.key === "Escape" && (!useVim || inNormal(v))) return opts.cancel(), take();
            return false;
          },
          // A click inside a lit phrase keeps it as words; the caret stays where it landed.
          click: (_e, v) => {
            const at = v.state.selection.main;
            const hit = at.empty && parsed?.spans.find((s) => at.head > s.from && at.head < s.to);
            if (hit) (ignore.add(phrase(firstLine().slice(hit.from, hit.to))), render());
            return false;
          },
          focus: (_e, v) => {
            loadPools();
            // An empty field is for typing: with Vim it takes focus in insert mode.
            const cm = getCM(v);
            if (cm && !v.state.doc.length && inNormal(v)) setTimeout(() => Vim.handleKey(cm, "i", "mapping"));
            return false;
          },
          blur: () => (opts.blur?.(), false),
        }),
      ),
      opts.multiline ? keymap.of([{ key: "Shift-Enter", run: insertNewline }]) : [],
      autocompletion({ override: [suggest], icons: false }),
      spansField,
      placeholder(opts.placeholder ?? PLACEHOLDER),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => u.docChanged && (opts.typed?.(), render())),
      EditorView.contentAttributes.of({ "aria-label": opts.placeholder ?? PLACEHOLDER, spellcheck: "true" }),
    ],
  });
  view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });
  // An empty field is for typing: with Vim it starts in insert mode, so the first key typed is text.
  const cm = getCM(view);
  if (cm && !view.state.doc.length) Vim.handleKey(cm, "i", "mapping");
  render();

  return {
    dom: el("div", { class: `qa-box qa-cm${opts.compact ? " qa-compact" : ""}${opts.multiline ? " is-multiline" : ""}` }, view.dom),
    preview,
    focus() {
      if (view.hasFocus) return;
      view.focus();
      const cm = getCM(view);
      if (cm && inNormal(view)) Vim.handleKey(cm, useVim && view.state.doc.length ? "A" : "i", "mapping"); // ready to type, at the end
    },
    value: () => view.state.doc.toString(),
    clear: () => (ignore.clear(), view.dispatch({ changes: { from: 0, to: view.state.doc.length } })),
    ignore: () => [...ignore],
    parsed: () => parsed,
    render,
    destroy: () => view.destroy(),
  };
}
