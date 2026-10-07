// The CodeMirror 6 editor, as plain as it comes: CommonMark (or JSON) highlighting and standard keys.
// Everything else (Vim keys, live preview, tasks) comes from extensions, through `extensions`, and what
// they add to the markdown language (GFM, code blocks' languages, math) through addMarkdownSyntax.
// Directives (`::timer{…}`, `:::kanban` … `:::`) are core: embeds are written with them.
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { commonmarkLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, Language, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import type { MarkdownExtension, MarkdownParser } from "@lezer/markdown";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { linePatch } from "./line-diff.ts";
import type { Settings } from "../../worker/src/settings.ts";
import type { FilePath } from "../../worker/src/files.ts";
import { directiveSyntax } from "./directives.ts";
import { editorFile } from "./embeds.ts";
import { previewEnabled } from "./live-preview.ts";

/** Marks text that came from the server, so it isn't saved back as an edit. */
export const fromServer = Annotation.define<boolean>();

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--prose)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { maxWidth: "42rem", margin: "0 auto", padding: "3rem clamp(0.75rem, 4%, 2rem) 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-fat-cursor": { background: "var(--accent) !important", color: "var(--bg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--ink)", borderTop: "1px solid var(--line)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none", fontFamily: "var(--mono)", fontSize: "0.8em" },
  ".cm-remote-change": { backgroundColor: "var(--accent-soft)", transition: "background-color 600ms" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "650" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "650" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--muted)" },
]);

const mono = EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } });

/** Marks a change copied over from another view of the same file. */
export const synced = Annotation.define<boolean>();

/** The markdown language: CommonMark with directives (core, for embeds), then what extensions have added, in order. */
const markdownSyntax: MarkdownExtension[] = [directiveSyntax];
const withSyntax = () => new LanguageSupport(new Language(commonmarkLanguage.data, (commonmarkLanguage.parser as MarkdownParser).configure(markdownSyntax), [], "markdown"));
let markdownSupport = withSyntax();

/**
 * Add to the markdown language: new syntax (GFM's tables, math) or how code blocks parse. Editors made
 * after this have it; reconfigure() gives it to editors already open.
 */
export function addMarkdownSyntax(extension: MarkdownExtension): void {
  markdownSyntax.push(extension);
  // As lang-markdown makes its languages, without markdown(), which would bring HTML, CSS and JavaScript parsers.
  markdownSupport = withSyntax();
}

/** The markdown language notes are parsed with now, with what extensions have added. */
export const markdownLanguageSupport = (): LanguageSupport => markdownSupport;

/** Boxes that float over the editors, such as the phone's not-saved pill: the cursor isn't scrolled under them, at the top or the bottom. */
const floating: HTMLElement[] = [];
export function floatsOverEditors(el: HTMLElement): void {
  floating.push(el);
}
const clearOfFloating = EditorView.scrollMargins.of((view) => {
  const scroller = view.scrollDOM.getBoundingClientRect();
  let top = 0;
  let bottom = 0;
  for (const el of floating) {
    if (!el.getClientRects().length) continue;
    const box = el.getBoundingClientRect();
    if (box.right <= scroller.left || scroller.right <= box.left) continue;
    if (box.top < scroller.top + scroller.height / 2) top = Math.max(top, box.bottom + 8 - scroller.top);
    else bottom = Math.max(bottom, scroller.bottom - box.top + 8);
  }
  return top > 0 || bottom > 0 ? { top, bottom } : null;
});

/** The parts of the editor that settings change, each in its own compartment so it can change live. */
const slots = { lineNumbers: new Compartment(), wrapping: new Compartment(), fontSize: new Compartment(), livePreview: new Compartment(), markdown: new Compartment() };

export type EditorSettings = Pick<Settings, "editor.lineNumbers" | "editor.lineWrapping" | "editor.fontSize" | "editor.livePreview">;

const extensionsFor = (s: EditorSettings) => ({
  lineNumbers: s["editor.lineNumbers"] ? lineNumbers() : [],
  wrapping: s["editor.lineWrapping"] ? EditorView.lineWrapping : [],
  fontSize: EditorView.theme({ ".cm-scroller": { fontSize: `${s["editor.fontSize"]}px` } }),
  livePreview: previewEnabled.of(s["editor.livePreview"]),
  // Only in markdown editors: elsewhere the compartment isn't there, and reconfiguring it does nothing.
  markdown: markdownSupport,
});

/** Apply new settings to an open editor. */
export function reconfigure(view: EditorView, settings: EditorSettings) {
  const next = extensionsFor(settings);
  view.dispatch({ effects: (Object.keys(slots) as Array<keyof typeof slots>).map((k) => slots[k].reconfigure(next[k])) });
}

export function createState(
  doc: string,
  opts: { json: boolean; code?: boolean; readOnly: boolean; settings: EditorSettings; extensions: Extension[]; onUpdate: (u: ViewUpdate) => void; onBlur: () => void; path?: FilePath },
): EditorState {
  const s = extensionsFor(opts.settings);
  return EditorState.create({
    doc,
    extensions: [
      slots.lineNumbers.of(s.lineNumbers),
      slots.wrapping.of(s.wrapping),
      slots.fontSize.of(s.fontSize),
      slots.livePreview.of(s.livePreview),
      lastEdit,
      historySlot.of(noteHistory),
      drawSelection(),
      // Several selections at once: Vim's visual block (Ctrl-V) edits every line it covers with them.
      // Only it makes them: a click with ⌘ or Ctrl doesn't add a cursor (a near miss on a link would).
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of(() => false),
      remoteFlash,
      clearOfFloating,
      keymap.of([...(opts.json || opts.code ? [] : markdownKeymap), ...defaultKeymap.filter((b) => !ADDS_CURSORS.includes(b.key ?? "")), ...historyKeymap]),
      // Tab and Shift-Tab indent the line, so the keyboard stays in the note. Last of all keys, so an
      // extension's Tab comes first: Lists' on a list item, Vim's at the cursor in insert mode.
      Prec.low(keymap.of([indentWithTab])),
      // CommonMark and what extensions add (addMarkdownSyntax). markdown() would also load HTML, CSS and JavaScript.
      // Code (an extension's JavaScript) is plain monospaced text, so the bundle needn't carry a JavaScript parser.
      opts.json ? [json(), mono] : opts.code ? mono : slots.markdown.of(s.markdown),
      syntaxHighlighting(highlight),
      theme,
      EditorState.readOnly.of(opts.readOnly),
      editorFile.of(opts.path ?? null),
      opts.extensions,
      EditorView.contentAttributes.of(opts.json || opts.code ? { spellcheck: "false" } : { spellcheck: "true", autocapitalize: "sentences" }),
      EditorView.updateListener.of(opts.onUpdate),
      EditorView.domEventHandlers({ blur: () => void opts.onBlur() }),
    ],
  });
}

/** The changes that turn the editor's text into `text`, line by line, so the cursor stays put. */
function lineChanges(view: EditorView, text: string) {
  const old = linesOf(view.state.doc.toString());
  const starts = [0];
  for (const line of old) starts.push(starts.at(-1)! + line.length);
  const patch = linePatch(old, linesOf(text));
  const changes = patch.map(({ buffer1, buffer2 }) => ({
    from: starts[buffer1.offset],
    to: starts[buffer1.offset + buffer1.length],
    insert: buffer2.chunk.join(""),
  }));
  return { patch, changes };
}

/** Change the editor's text to `text` as an edit of yours, line by line: `u` takes it back. */
export function editText(view: EditorView, text: string) {
  view.dispatch({ changes: lineChanges(view, text).changes, userEvent: "input.replace" });
}

/** The default keys that add a cursor above or below (⌘⌥↑ and ⌘⌥↓): multiple cursors come from Vim's block only. */
const ADDS_CURSORS = ["Mod-Alt-ArrowUp", "Mod-Alt-ArrowDown"];

/**
 * The keys a note's editor takes on one platform, written as shortcuts are ("Mod-z"), and the browser's
 * copy, cut and paste: a sandboxed extension can't bind them. CodeMirror's ⌘ (Cmd, Meta) is Mod on a Mac.
 */
export function editorKeys(mac: boolean): string[] {
  const keys = [...markdownKeymap, ...defaultKeymap, ...historyKeymap].flatMap((b) => (mac ? [b.mac ?? b.key] : [b.win ?? b.key, b.linux ?? b.key]));
  return [...keys.flatMap((k) => (k ? [mac ? k.replace(/\b(Cmd|Meta)(?=-)/g, "Mod") : k] : [])), "Mod-c", "Mod-x", "Mod-v"];
}

/** How close in time two edits side by side are to be one undo step: CodeMirror's history's default. */
const JOIN_MS = 500;
const timeOf = (tr: Transaction) => tr.annotation(Transaction.time) ?? Date.now();
/**
 * When the last edit the history keeps was made. An undo or redo isn't one to join onto (none, as
 * CodeMirror's history has it): what's typed next is a step of its own.
 */
const lastEdit = StateField.define<number>({
  create: () => 0,
  update: (time, tr) => (tr.isUserEvent("undo") || tr.isUserEvent("redo") ? 0 : tr.docChanged && tr.annotation(Transaction.addToHistory) !== false ? timeOf(tr) : time),
});

/** The editor's undo history, in a slot of its own so it can be started afresh (see forgetHistory). */
const historySlot = new Compartment();
// Two quick edits side by side are one undo step, as CodeMirror's history has it by default. Its own
// time limit is lifted so an extension can join edits further apart (Vim's insert, typed slowly).
const noteHistory = history({ newGroupDelay: Number.MAX_SAFE_INTEGER, joinToEvent: (tr, adjacent) => adjacent && timeOf(tr) - tr.startState.field(lastEdit) < JOIN_MS });

/** An undo history with nothing in it, to start one afresh from. */
const emptyHistory = () => EditorState.create({ extensions: history() }).field(historyField);

/**
 * Start the undo history afresh: the text it would undo and redo has been replaced under it (theirs
 * taken in where yours clashed), so its steps would land in the wrong places. The one history field
 * every history config shares (an extension may add its own) starts again empty. Not during an update.
 */
export function forgetHistory(view: EditorView): void {
  view.dispatch({ effects: historySlot.reconfigure([noteHistory, historyField.init(emptyHistory)]) });
}

/** Replace the editor's text with the server's, line by line so the cursor stays put. `u` doesn't undo it. */
export function replaceText(view: EditorView, text: string, flash = false) {
  const { patch, changes } = lineChanges(view, text);
  view.dispatch({ changes, annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
  if (!flash) return;
  // Someone else's lines, highlighted for a moment, so you see what changed under you.
  const doc = view.state.doc;
  const lines = patch.flatMap(({ buffer2 }) => Array.from({ length: buffer2.length }, (_, i) => buffer2.offset + i + 1)).filter((n) => n <= doc.lines);
  if (!lines.length) return;
  const marks = Decoration.set(lines.map((n) => flashLine.range(doc.line(n).from)));
  view.dispatch({ effects: setFlash.of(marks) });
  window.setTimeout(() => view.dispatch({ effects: setFlash.of(Decoration.none) }), 1600);
}

const flashLine = Decoration.line({ class: "cm-remote-change" });
const setFlash = StateEffect.define<DecorationSet>();

/** The lines someone else just changed, highlighted briefly (replaceText with `flash`). */
export const remoteFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, tr) => {
    for (const e of tr.effects) if (e.is(setFlash)) return e.value;
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Lines with their newlines, so they join back into exactly the text. */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
