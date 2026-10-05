// Embeds (ADR 0006): something an extension draws in a note in place of its markdown, until the cursor
// is in it. Each embed is written the way its contribution says (contributes.embeds[].syntax):
// - a leaf directive, one line with nothing to close: `::timer{duration=25m label="Focus"}`
// - a container directive around markdown that stays markdown: `:::kanban` … `:::`
// - a fenced block around code: ```` ```html-app height=240 ```` … ```` ``` ````
// Its key=value attributes are the embed's arguments. Each drawn embed has a quiet toolbar: Settings
// (a form made from its declared arguments, which writes them back as your edit, keeping their order
// and quotes) and Edit markdown. An embed whose markdown changes is given its new arguments in place
// when its extension can take them, so its frame isn't reloaded. A container left unclosed says so.
// A block for an embed a Catalog extension draws, when it isn't installed, stays markdown, with a line
// above it offering to install it. A link alone on its own line is drawn too, by the extension whose
// urlEmbeds pattern matches it (a video, a post, a link card).
import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EmbedContribution, EmbedSyntax } from "../../worker/src/extensions.ts";
import type { FilePath } from "../../worker/src/files.ts";
import { attrsRecord, directiveText, parseAttrs, serializeAttrs, withValues, type Attr } from "./directives.ts";
import { embedForm } from "./embed-form.ts";
import { blockPreview, type BlockPreview } from "./live-preview.ts";

/** One embed in a note, as its extension gets it. */
export interface Embed {
  /** Its name: the directive's, or the fence's language. */
  language: string;
  syntax: EmbedSyntax;
  /** Its key=value arguments. */
  args: Record<string, string>;
  /** A container's markdown, or a fence's code, between its first and last lines. */
  body: string;
  /** The note it's in. */
  note: FilePath | null;
  /**
   * Stable for this embed: its note and its `id` argument, or which of the note's embeds of its kind
   * it is. Extensions key the state they keep for an embed by it.
   */
  key: string;
}

/** What draws embeds: the app's extension runtime. */
export interface EmbedHost {
  /** The embeds extensions that are on declare, by name. */
  contributions(): ReadonlyMap<string, EmbedContribution>;
  /** Draw an embed into `el`, once per showing; `tools` is its toolbar, for buttons of its own (Stop). */
  draw(el: HTMLElement, embed: Embed, tools: HTMLElement): void;
  /** Give the embed drawn in `el` new arguments or a new body, in place; false if it can't take them, and it's drawn again. */
  update(el: HTMLElement, embed: Embed): boolean;
  /** The Catalog extension that would draw an embed no installed extension does, and installing it. */
  needs(language: string): { name: string; install(): Promise<void> } | null;
  /** Which URL embed draws a link alone on its line, if one does: its id. */
  urlEmbed(url: string): string | null;
  drawUrl(el: HTMLElement, url: string, id: string): void;
}

/** A line that's just a link: https://… or <https://…>. */
const LINK_LINE = /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/;

class UrlWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly id: string,
    readonly host: EmbedHost,
  ) {
    super();
  }
  eq(other: UrlWidget) {
    return other.url === this.url && other.id === this.id;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed cm-url-embed";
    el.dataset.urlEmbed = this.id;
    this.host.drawUrl(el, this.url, this.id);
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

/** Every link alone on a line of its own, outside lists and quotes, with the URL embed that draws it. */
export function findUrlEmbeds(state: EditorState, host: Pick<EmbedHost, "urlEmbed">): Array<{ from: number; to: number; url: string; id: string }> {
  const out: Array<{ from: number; to: number; url: string; id: string }> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Document") return;
      if (node.name !== "Paragraph") return false;
      const line = state.doc.lineAt(node.from);
      if (line.to < node.to) return false;
      const url = LINK_LINE.exec(line.text)?.[1];
      const id = url ? host.urlEmbed(url) : null;
      if (url && id) out.push({ from: line.from, to: line.to, url, id });
      return false;
    },
  });
  return out;
}

/** The file an editor shows, for what's drawn in it to know. */
export const editorFile = Facet.define<FilePath | null, FilePath | null>({ combine: (values) => values.at(-1) ?? null });

/** A fence's info string: its language, and its key=value arguments. Values may be quoted: label="Deep work". */
export function parseInfo(info: string): { language: string; attrs: Attr[] } {
  const language = /^\s*([^\s]*)/.exec(info)![1];
  return { language, attrs: parseAttrs(info.slice(info.indexOf(language) + language.length)) };
}

/** An embed where it is in the note: the whole block, and its first line, which holds its name and arguments. */
export interface Found {
  from: number;
  to: number;
  /** The first line: where the arguments are written. */
  head: { from: number; to: number };
  attrs: Attr[];
  embed: Embed;
}

/** What a note's top-level blocks hold: embeds, and containers opened but never closed. */
export interface Scan {
  found: Found[];
  /** A container directive with no `:::` after it: where it opens, and its name. */
  unclosed: Array<{ from: number; language: string }>;
}

/** Every embed in a note, of the kinds `declared` says, with where each is. Only blocks at the note's top level are embeds. */
export function findEmbeds(state: EditorState, declared: ReadonlyMap<string, Pick<EmbedContribution, "syntax">>): Scan {
  const found: Found[] = [];
  const unclosed: Scan["unclosed"] = [];
  const seen = new Map<string, number>();
  const note = state.facet(editorFile);
  const doc = state.doc;
  const add = (from: number, to: number, head: { from: number; to: number }, language: string, syntax: EmbedSyntax, attrs: Attr[], body: string) => {
    const n = seen.get(language) ?? 0;
    seen.set(language, n + 1);
    const args = attrsRecord(attrs);
    found.push({ from, to, head, attrs, embed: { language, syntax, args, body, note, key: `${note ?? ""}#${args.id ?? `${language}:${n}`}` } });
  };
  const braced = (node: { getChild(name: string): { from: number; to: number } | null }) => {
    const braces = node.getChild("DirectiveAttributes");
    return parseAttrs(braces ? doc.sliceString(braces.from + 1, braces.to - 1) : "");
  };
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const line = doc.lineAt(node.from);
    if (node.name === "LeafDirective") {
      const language = nameOf(state, node) ?? "";
      if (declared.get(language)?.syntax === "leaf") add(line.from, line.to, { from: line.from, to: line.to }, language, "leaf", braced(node), "");
    } else if (node.name === "DirectiveOpen") {
      const language = nameOf(state, node) ?? "";
      if (declared.get(language)?.syntax !== "container") continue;
      // Its close is the next `:::` at this level, past any containers opened inside it.
      let depth = 0;
      let close = null;
      for (let next = node.nextSibling; next && !close; next = next.nextSibling) {
        if (next.name === "DirectiveOpen") depth++;
        else if (next.name === "DirectiveClose") {
          if (depth === 0) close = next;
          else depth--;
        }
      }
      if (!close) {
        unclosed.push({ from: line.from, language });
        continue;
      }
      const end = doc.lineAt(close.to);
      const body = line.number + 1 <= end.number - 1 ? doc.sliceString(doc.line(line.number + 1).from, doc.line(end.number - 1).to) : "";
      add(line.from, end.to, { from: line.from, to: line.to }, language, "container", braced(node), body);
      node = close;
    } else if (node.name === "FencedCode") {
      const info = node.getChild("CodeInfo");
      if (!info) continue;
      const { language, attrs } = parseInfo(doc.sliceString(info.from, doc.lineAt(info.from).to));
      if (declared.get(language)?.syntax !== "fence") continue;
      const text = node.getChild("CodeText");
      add(node.from, node.to, { from: line.from, to: line.to }, language, "fence", attrs, text ? doc.sliceString(text.from, text.to) : "");
    }
  }
  return { found, unclosed };
}

/** An embed's first line written again with new arguments: the directive line, or the fence's opening. */
export function headWith(found: Pick<Found, "embed">, attrs: Attr[], headText: string): string {
  const { language, syntax } = found.embed;
  if (syntax === "leaf") return directiveText("::", { name: language, attrs });
  if (syntax === "container") return directiveText(":::", { name: language, attrs });
  const fence = /^\s*(`{3,}|~{3,})/.exec(headText)?.[1] ?? "```";
  const inside = serializeAttrs(attrs);
  return `${fence}${language}${inside ? ` ${inside}` : ""}`;
}

const sameEmbed = (a: Embed, b: Embed) => a.key === b.key && a.syntax === b.syntax && a.body === b.body && JSON.stringify(a.args) === JSON.stringify(b.args);

/** The embed each drawn box shows now: given new arguments in place, a box keeps going with them. */
const showing = new WeakMap<HTMLElement, Embed>();

class EmbedWidget extends WidgetType {
  constructor(
    readonly embed: Embed,
    readonly host: EmbedHost,
  ) {
    super();
  }
  eq(other: EmbedWidget) {
    return sameEmbed(this.embed, other.embed);
  }
  /** The same embed with new arguments or body: its extension takes them in place when it can, so nothing reloads. */
  updateDOM(dom: HTMLElement) {
    const was = showing.get(dom);
    if (!was || was.key !== this.embed.key || was.syntax !== this.embed.syntax) return false;
    const body = dom.querySelector<HTMLElement>(":scope > .cm-embed-body");
    if (!body || !this.host.update(body, this.embed)) return false;
    showing.set(dom, this.embed);
    return true;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed";
    el.dataset.embed = this.embed.language;
    showing.set(el, this.embed);
    const tools = document.createElement("div");
    tools.className = "cm-embed-tools";
    const body = document.createElement("div");
    body.className = "cm-embed-body";
    el.append(tools, body);
    const contribution = this.host.contributions().get(this.embed.language);
    const tool = (label: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", run);
      tools.append(b);
    };
    if (contribution && Object.values(contribution.arguments).some((a) => !a.hidden)) tool("Settings", `${contribution.title}'s settings`, () => openForm(view, el, contribution));
    tool("Edit markdown", "Put the cursor in its markdown", () => editMarkdown(view, el));
    this.host.draw(body, this.embed, tools);
    // A click on its edge (not inside what it draws) puts the cursor in its markdown, to edit it.
    el.addEventListener("mousedown", (e) => {
      if (e.target !== el) return;
      e.preventDefault();
      editMarkdown(view, el);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** The embed a drawn box is for, where it is in the note now. */
function foundAt(view: EditorView, el: HTMLElement): Found | null {
  const embed = showing.get(el);
  if (!embed) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(el);
  } catch {
    return null;
  }
  return findEmbeds(view.state, new Map([[embed.language, { syntax: embed.syntax }]])).found.find((f) => f.from === pos) ?? null;
}

/** Put the cursor at the end of an embed's first line, where its name and arguments are. */
function editMarkdown(view: EditorView, el: HTMLElement) {
  const at = foundAt(view, el);
  if (at) view.dispatch({ selection: { anchor: at.head.to }, scrollIntoView: true });
  view.focus();
}

/** The settings form under an embed: its arguments, from its contribution. Save writes them into its markdown, as your edit. */
function openForm(view: EditorView, el: HTMLElement, contribution: EmbedContribution) {
  const open = el.querySelector<HTMLElement>(":scope > .cm-embed-form");
  if (open) {
    open.remove();
    return view.requestMeasure();
  }
  const at = foundAt(view, el);
  if (!at) return;
  const done = () => {
    form.remove();
    view.requestMeasure();
    view.focus();
  };
  const form = embedForm(contribution, at.attrs, {
    preview: (attrs) => headWith(at, attrs, view.state.doc.sliceString(at.head.from, at.head.to)),
    save: (values) => {
      done();
      // Where it is now: the note may have changed while the form was open.
      const now = foundAt(view, el);
      if (!now) return;
      const was = view.state.doc.sliceString(now.head.from, now.head.to);
      const head = headWith(now, withValues(now.attrs, values), was);
      if (head !== was) view.dispatch({ changes: { from: now.head.from, to: now.head.to, insert: head }, userEvent: "input.embed" });
    },
    cancel: done,
  });
  el.append(form);
  view.requestMeasure();
  form.querySelector<HTMLElement>("input, select")?.focus();
}

/** A line over an embed's markdown, saying what's wrong with it or what it needs. */
class NoteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly install: (() => Promise<void>) | null,
  ) {
    super();
  }
  eq(other: NoteWidget) {
    return other.text === this.text && !!other.install === !!this.install;
  }
  toDOM() {
    const bar = document.createElement("div");
    bar.className = "cm-embed-needs";
    bar.append(this.text);
    if (this.install) {
      const install = document.createElement("button");
      install.type = "button";
      install.textContent = "Install";
      install.addEventListener("mousedown", (e) => e.preventDefault());
      install.addEventListener("click", () => {
        install.disabled = true;
        install.textContent = "Installing…";
        void this.install!().catch(() => {
          install.disabled = false;
          install.textContent = "Install";
        });
      });
      bar.append(" · ", install);
    }
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

/** The name a top-level block would be drawn by: a directive's name, or a fence's language. */
function nameOf(state: EditorState, node: { name: string; from: number; getChild(name: string): { from: number; to: number } | null }): string | null {
  if (node.name === "LeafDirective" || node.name === "DirectiveOpen") {
    const name = node.getChild("DirectiveName");
    return name ? state.doc.sliceString(name.from, name.to) : null;
  }
  if (node.name === "FencedCode") {
    const info = node.getChild("CodeInfo");
    return info ? parseInfo(state.doc.sliceString(info.from, state.doc.lineAt(info.from).to)).language : null;
  }
  return null;
}

/** Lines above embeds that can't be drawn yet: one whose Catalog extension isn't installed, or a container left unclosed. */
function noteBars(state: EditorState, host: EmbedHost): DecorationSet {
  const bars: Range<Decoration>[] = [];
  const declared = host.contributions();
  const bar = (from: number, widget: NoteWidget) => bars.push(Decoration.widget({ widget, block: true, side: -1 }).range(from));
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const language = nameOf(state, node);
    const needs = language && !declared.has(language) ? host.needs(language) : null;
    if (needs) bar(state.doc.lineAt(node.from).from, new NoteWidget(`This needs ${needs.name} from the Catalog`, () => needs.install()));
  }
  for (const { from, language } of findEmbeds(state, declared).unclosed) {
    bar(from, new NoteWidget(`This ${declared.get(language)?.title ?? language} isn't closed: add a line with ::: after its last line.`, null));
  }
  return Decoration.set(bars, true);
}

/** Embeds drawn in place of their markdown, in a note's editor. */
export function embeds(host: EmbedHost) {
  return [
    StateField.define<DecorationSet>({
      create: (state) => noteBars(state, host),
      update: (bars, tr) => (tr.docChanged || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? noteBars(tr.state, host) : bars),
      provide: (field) => EditorView.decorations.from(field),
    }),
    blockPreview((state): BlockPreview[] => findEmbeds(state, host.contributions()).found.map(({ from, to, embed }) => ({ from, to, widget: new EmbedWidget(embed, host) }))),
    blockPreview((state): BlockPreview[] => findUrlEmbeds(state, host).map(({ from, to, url, id }) => ({ from, to, widget: new UrlWidget(url, id, host) }))),
    EditorView.theme({
      ".cm-embed": { position: "relative", padding: "0.6em 0 0.25em", cursor: "text" },
      // On the top edge of what it draws, over its border rather than over what it shows.
      ".cm-embed-tools": { position: "absolute", top: "0", right: "0.5rem", zIndex: "2", display: "flex", gap: "0.25rem", opacity: "0", transition: "opacity 120ms" },
      ".cm-embed:hover > .cm-embed-tools, .cm-embed-tools:focus-within": { opacity: "1" },
      ".cm-embed-tools button": {
        font: "0.7rem var(--prose)",
        color: "var(--muted)",
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: "4px",
        padding: "0 0.4em",
        lineHeight: "1.1rem",
        cursor: "pointer",
      },
      ".cm-embed-tools button:hover": { color: "var(--ink)" },
      ".cm-embed-frame": { position: "relative", border: "1px solid var(--line)", borderRadius: "6px", overflow: "hidden" },
      ".cm-embed-frame iframe.webview": { display: "block", width: "100%", height: "100%", border: "0", background: "transparent" },
      ".cm-embed-stopped": { display: "flex", gap: "0.5em", alignItems: "center", padding: "0.5em 0.75em", color: "var(--muted)", fontSize: "0.85em" },
      ".cm-embed-missing": { color: "var(--muted)", fontSize: "0.85em" },
      ".cm-embed-needs": { color: "var(--muted)", fontSize: "0.8em", fontFamily: "var(--prose)", padding: "0.2em 0" },
      ".cm-embed-needs button": { font: "inherit", color: "var(--accent)", background: "none", border: "none", padding: "0", cursor: "pointer", textDecoration: "underline" },
      ".cm-embed-loading": { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: "0.8em", fontFamily: "var(--prose)", pointerEvents: "none" },
      ".cm-embed-form": {
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        gap: "0.4rem 0.75rem",
        alignItems: "center",
        margin: "0.4rem 0 0.25rem",
        padding: "0.6rem 0.75rem",
        border: "1px solid var(--line)",
        borderRadius: "6px",
        fontFamily: "var(--prose)",
        fontSize: "0.85rem",
        cursor: "default",
      },
      ".cm-embed-form > label": { color: "var(--muted)" },
      ".cm-embed-form input:not([type=checkbox]), .cm-embed-form select": { font: "inherit", color: "var(--ink)", background: "transparent", border: "1px solid var(--line)", borderRadius: "4px", padding: "0.15rem 0.4rem", minWidth: "0" },
      ".cm-embed-form .presets": { display: "flex", flexWrap: "wrap", gap: "0.25rem", gridColumn: "2" },
      ".cm-embed-form button": { font: "inherit", fontSize: "0.8rem", color: "var(--accent)", background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "0 0.4rem", cursor: "pointer" },
      ".cm-embed-form .hint": { gridColumn: "2", color: "var(--muted)", fontSize: "0.75rem", marginTop: "-0.25rem" },
      ".cm-embed-form .actions": { gridColumn: "1 / -1", display: "flex", gap: "0.5rem", alignItems: "center" },
      ".cm-embed-form .actions code": { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted)", fontFamily: "var(--mono)", fontSize: "0.75rem" },
      ".cm-embed-form .actions code.is-error": { color: "#c2410c" },
      ".cm-embed-form .actions button[type=submit]": { color: "var(--bg)", background: "var(--accent)", borderColor: "var(--accent)" },
    }),
  ];
}
