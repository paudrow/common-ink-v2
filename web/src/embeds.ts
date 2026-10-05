// Embeds (ADR 0006): a fenced code block whose info string starts with a language an extension declares
// in contributes.embeds, drawn by that extension where the block is, until the cursor is in it. The
// info string's key=value words are the embed's arguments (```timer duration=25m label="Focus"), and
// the body is whatever the embed takes (an html-app's HTML). Webviews (code an extension runs) sit in
// a quiet frame with a Stop button. A block for an embed a Catalog extension draws, when it isn't
// installed, stays code, with a line above it offering to install it.
import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { FilePath } from "../../worker/src/files.ts";
import { blockPreview, type BlockPreview } from "./live-preview.ts";

/** One embed in a note, as its extension gets it. */
export interface Embed {
  language: string;
  /** The info string's key=value arguments. */
  args: Record<string, string>;
  /** The block's body: the lines between its fences. */
  body: string;
  /** The note it's in. */
  note: FilePath | null;
  /**
   * Stable for this embed: its note and its `id` argument, or which of the note's blocks of its
   * language it is. Extensions key the state they keep for an embed by it.
   */
  key: string;
}

/** What draws embeds: the app's extension runtime. `el` is the embed's box; it's drawn into once per showing. */
export interface EmbedHost {
  languages(): ReadonlySet<string>;
  draw(el: HTMLElement, embed: Embed): void;
  /** The Catalog extension that would draw a language no installed extension does, and installing it. */
  needs(language: string): { name: string; install(): Promise<void> } | null;
}

/** The file an editor shows, for what's drawn in it to know. */
export const editorFile = Facet.define<FilePath | null, FilePath | null>({ combine: (values) => values.at(-1) ?? null });

/** An info string's language and key=value arguments. Values may be quoted: label="Deep work". */
export function parseInfo(info: string): { language: string; args: Record<string, string> } {
  const language = /^\s*([^\s]*)/.exec(info)![1];
  const args: Record<string, string> = {};
  for (const m of info.slice(info.indexOf(language) + language.length).matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)) args[m[1]] = m[2] ?? m[3] ?? m[4];
  return { language, args };
}

/** The language a fenced block names, if it names one. */
function languageOf(state: EditorState, node: { node: { getChild(name: string): { from: number } | null } }): string | null {
  const info = node.node.getChild("CodeInfo");
  return info ? parseInfo(state.doc.sliceString(info.from, state.doc.lineAt(info.from).to)).language : null;
}

/** Every embed in a note, with where its block is. */
export function findEmbeds(state: EditorState, languages: ReadonlySet<string>): Array<{ from: number; to: number; embed: Embed }> {
  const out: Array<{ from: number; to: number; embed: Embed }> = [];
  const seen = new Map<string, number>();
  const note = state.facet(editorFile);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info) return false;
      const { language, args } = parseInfo(state.doc.sliceString(info.from, state.doc.lineAt(info.from).to));
      if (!languages.has(language)) return false;
      const n = seen.get(language) ?? 0;
      seen.set(language, n + 1);
      const text = node.node.getChild("CodeText");
      const body = text ? state.doc.sliceString(text.from, text.to) : "";
      out.push({ from: node.from, to: node.to, embed: { language, args, body, note, key: `${note ?? ""}#${args.id ?? `${language}:${n}`}` } });
      return false;
    },
  });
  return out;
}

class EmbedWidget extends WidgetType {
  constructor(
    readonly embed: Embed,
    readonly host: EmbedHost,
  ) {
    super();
  }
  eq(other: EmbedWidget) {
    const a = this.embed;
    const b = other.embed;
    return a.key === b.key && a.body === b.body && JSON.stringify(a.args) === JSON.stringify(b.args);
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed";
    el.dataset.embed = this.embed.language;
    this.host.draw(el, this.embed);
    // A click on its edge (not inside what it draws) puts the cursor in the block, to edit it.
    el.addEventListener("mousedown", (e) => {
      if (e.target !== el) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** A line over a block an uninstalled Catalog extension would draw, offering to install it. */
class NeedsWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly name: string,
    readonly host: EmbedHost,
  ) {
    super();
  }
  eq(other: NeedsWidget) {
    return other.language === this.language && other.name === this.name;
  }
  toDOM() {
    const bar = document.createElement("div");
    bar.className = "cm-embed-needs";
    const install = document.createElement("button");
    install.type = "button";
    install.textContent = "Install";
    install.addEventListener("mousedown", (e) => e.preventDefault());
    install.addEventListener("click", () => {
      install.disabled = true;
      install.textContent = "Installing…";
      void this.host
        .needs(this.language)
        ?.install()
        .catch(() => {
          install.disabled = false;
          install.textContent = "Install";
        });
    });
    bar.append(`This needs ${this.name} from the Catalog · `, install);
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

function needBars(state: EditorState, host: EmbedHost): DecorationSet {
  const bars: Range<Decoration>[] = [];
  const drawn = host.languages();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const language = languageOf(state, node);
      const needs = language && !drawn.has(language) ? host.needs(language) : null;
      if (needs) bars.push(Decoration.widget({ widget: new NeedsWidget(language!, needs.name, host), block: true, side: -1 }).range(state.doc.lineAt(node.from).from));
      return false;
    },
  });
  return Decoration.set(bars, true);
}

/** Embeds drawn in place of their blocks, in a note's editor. */
export function embeds(host: EmbedHost) {
  return [
    StateField.define<DecorationSet>({
      create: (state) => needBars(state, host),
      update: (bars, tr) => (tr.docChanged || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? needBars(tr.state, host) : bars),
      provide: (field) => EditorView.decorations.from(field),
    }),
    blockPreview((state): BlockPreview[] => findEmbeds(state, host.languages()).map(({ from, to, embed }) => ({ from, to, widget: new EmbedWidget(embed, host) }))),
    EditorView.theme({
      ".cm-embed": { padding: "0.6em 0 0.25em", cursor: "text" },
      ".cm-embed-frame": { position: "relative", border: "1px solid var(--line)", borderRadius: "6px" },
      ".cm-embed-frame > div:first-child": { borderRadius: "6px", overflow: "hidden" },
      ".cm-embed-frame iframe.webview": { display: "block", width: "100%", height: "100%", border: "0", background: "transparent" },
      // On the frame's top edge, over its border rather than what it shows.
      ".cm-embed-stop": {
        position: "absolute",
        top: "-0.6rem",
        right: "0.5rem",
        font: "0.7rem var(--prose)",
        color: "var(--muted)",
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: "4px",
        padding: "0 0.4em",
        cursor: "pointer",
        opacity: "0.75",
        lineHeight: "1.1rem",
      },
      ".cm-embed-frame:hover .cm-embed-stop, .cm-embed-stop:focus-visible": { opacity: "1" },
      ".cm-embed-stopped": { display: "flex", gap: "0.5em", alignItems: "center", padding: "0.5em 0.75em", color: "var(--muted)", fontSize: "0.85em" },
      ".cm-embed-missing": { color: "var(--muted)", fontSize: "0.85em" },
      ".cm-embed-needs": { color: "var(--muted)", fontSize: "0.8em", fontFamily: "var(--prose)", padding: "0.2em 0" },
      ".cm-embed-needs button": { font: "inherit", color: "var(--accent)", background: "none", border: "none", padding: "0", cursor: "pointer", textDecoration: "underline" },
      ".cm-embed-loading": { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: "0.8em", fontFamily: "var(--prose)", pointerEvents: "none" },
    }),
  ];
}
