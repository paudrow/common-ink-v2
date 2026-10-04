// The CodeMirror 6 editor: vim first, markdown (or JSON) highlighting, and nothing else on screen.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { vim } from "@replit/codemirror-vim";
import { diffPatch } from "node-diff3";
import type { Settings } from "../../worker/src/settings.ts";

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
  ".cm-vim-panel": { padding: "0.25rem 1rem", fontFamily: "var(--mono)" },
  ".cm-vim-panel input": { color: "var(--ink)", fontFamily: "var(--mono)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none", fontFamily: "var(--mono)", fontSize: "0.8em" },
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

/** Marks a change copied over from another view of the same doc. */
export const synced = Annotation.define<boolean>();

/** The parts of the editor that settings change, each in its own compartment so it can change live. */
const slots = { vim: new Compartment(), lineNumbers: new Compartment(), wrapping: new Compartment(), fontSize: new Compartment() };

export type EditorSettings = Pick<Settings, "editor.vim" | "editor.lineNumbers" | "editor.lineWrapping" | "editor.fontSize">;

const extensionsFor = (s: EditorSettings) => ({
  vim: s["editor.vim"] ? vim() : [],
  lineNumbers: s["editor.lineNumbers"] ? lineNumbers() : [],
  wrapping: s["editor.lineWrapping"] ? EditorView.lineWrapping : [],
  fontSize: EditorView.theme({ ".cm-scroller": { fontSize: `${s["editor.fontSize"]}px` } }),
});

/** Apply new settings to an open editor. */
export function reconfigure(view: EditorView, settings: EditorSettings) {
  const next = extensionsFor(settings);
  view.dispatch({ effects: (Object.keys(slots) as Array<keyof typeof slots>).map((k) => slots[k].reconfigure(next[k])) });
}

export function createState(
  doc: string,
  opts: { json: boolean; readOnly: boolean; settings: EditorSettings; extensions: Extension[]; onUpdate: (u: ViewUpdate) => void; onBlur: () => void },
): EditorState {
  const s = extensionsFor(opts.settings);
  return EditorState.create({
    doc,
    extensions: [
      slots.vim.of(s.vim), // before other keymaps, so vim sees keys first
      slots.lineNumbers.of(s.lineNumbers),
      slots.wrapping.of(s.wrapping),
      slots.fontSize.of(s.fontSize),
      history(),
      drawSelection(),
      keymap.of([...(opts.json ? [] : markdownKeymap), ...defaultKeymap, ...historyKeymap]),
      // Just the markdown language: markdown() also loads HTML, CSS and JavaScript for embedded HTML.
      opts.json ? [json(), EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } })] : new LanguageSupport(markdownLanguage),
      syntaxHighlighting(highlight),
      theme,
      EditorState.readOnly.of(opts.readOnly),
      opts.extensions,
      EditorView.contentAttributes.of(opts.json ? { spellcheck: "false" } : { spellcheck: "true", autocapitalize: "sentences" }),
      EditorView.updateListener.of(opts.onUpdate),
      EditorView.domEventHandlers({ blur: () => void opts.onBlur() }),
    ],
  });
}

/** Replace the editor's text with the server's, line by line so the cursor stays put. `u` doesn't undo it. */
export function replaceText(view: EditorView, text: string) {
  const old = linesOf(view.state.doc.toString());
  const starts = [0];
  for (const line of old) starts.push(starts.at(-1)! + line.length);
  const changes = diffPatch(old, linesOf(text)).map(({ buffer1, buffer2 }) => ({
    from: starts[buffer1.offset],
    to: starts[buffer1.offset + buffer1.length],
    insert: buffer2.chunk.join(""),
  }));
  view.dispatch({ changes, annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
}

/** Lines with their newlines, so they join back into exactly the text. */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
