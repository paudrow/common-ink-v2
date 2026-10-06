// Directives, CommonMark's generic directives as remark-directive writes them: a leaf on a line of its
// own, `::timer{duration=25m label="Focus"}`, with nothing to close; and a container around markdown,
// `:::kanban{done="Shipped"}` … `:::`, whose lines stay real markdown (headings, lists, tasks, links).
// The parser marks them, and the editor highlights them quietly in raw text; embeds draw them. A
// container's opening and closing lines are nodes of their own, so what's between parses as usual.
import { tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

/** One key=value in a directive's braces, as written: its quotes are kept when it's written again. */
export interface Attr {
  key: string;
  value: string;
  quote: '"' | "'" | "";
}

/** A directive's name and the attributes in its braces, in order. */
export interface DirectiveLine {
  name: string;
  attrs: Attr[];
}

const NAME = "([a-z][\\w-]*)";
/**
 * What's in a directive's braces: anything but a brace or a quote, or a quoted value, which may hold a
 * brace. Each character can be read only one way, so a long line takes no longer than its length.
 * An unquoted quote (q=don't) makes the line text, not a directive.
 */
const BRACES = `(?:\\{((?:[^}"'\\n]|"[^"\\n]*"|'[^'\\n]*')*)\\})?`;
/** `::name{…}` alone on its line. */
export const LEAF = new RegExp(`^::${NAME}${BRACES}\\s*$`, "i");
/** `:::name{…}` opening a container. */
export const OPEN = new RegExp(`^:::${NAME}${BRACES}\\s*$`, "i");
/** `:::` closing one. */
export const CLOSE = /^:::\s*$/;

/** The attributes in a directive's braces: key=value, key="quoted value", or a bare key (true). */
export function parseAttrs(src: string): Attr[] {
  const out: Attr[] = [];
  for (const m of src.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?/g)) {
    const quote = m[2] !== undefined ? '"' : m[3] !== undefined ? "'" : "";
    out.push({ key: m[1], value: m[2] ?? m[3] ?? m[4] ?? "true", quote });
  }
  return out;
}

/** The attributes as a record, the way an embed reads them. */
export const attrsRecord = (attrs: readonly Attr[]): Record<string, string> => Object.fromEntries(attrs.map((a) => [a.key, a.value]));

/** A value written bare when it can be (25m, 07:30, Projects/Work), and in quotes when it has spaces or quotes. */
const needsQuotes = (value: string) => !/^[\w.:/+@#-]+$/.test(value);

/** The attributes as written between the braces. */
export function serializeAttrs(attrs: readonly Attr[]): string {
  return attrs
    .map(({ key, value, quote }) => {
      if (!quote && !needsQuotes(value)) return `${key}=${value}`;
      const q = quote || '"';
      // A value can't hold the quote it's written in; the other one stands in for it.
      return `${key}=${q}${value.replaceAll(q, q === '"' ? "'" : '"')}${q}`;
    })
    .join(" ");
}

/**
 * The attributes with new values: ones already there keep their place and their quotes, new ones go at
 * the end (before `id`, which stays last), and a value of "" or undefined takes the attribute out.
 */
export function withValues(attrs: readonly Attr[], values: Record<string, string | undefined>): Attr[] {
  const kept = attrs.flatMap((a) => {
    if (!(a.key in values)) return [a];
    const value = values[a.key];
    return value === undefined || value === "" ? [] : [{ ...a, value }];
  });
  const added = Object.entries(values)
    .filter(([key, value]) => value !== undefined && value !== "" && !attrs.some((a) => a.key === key))
    .map(([key, value]): Attr => ({ key, value: value!, quote: "" }));
  const id = kept.findIndex((a) => a.key === "id");
  return id < 0 ? [...kept, ...added] : [...kept.slice(0, id), ...added, ...kept.slice(id)];
}

/** A leaf or opening line, written again with new attributes. */
export function directiveText(colons: "::" | ":::", { name, attrs }: DirectiveLine): string {
  const inside = serializeAttrs(attrs);
  return inside ? `${colons}${name}{${inside}}` : `${colons}${name}`;
}

/** A line as a leaf directive or a container's opening, if it is one. */
export function parseDirectiveLine(text: string): (DirectiveLine & { kind: "leaf" | "open" }) | null {
  const leaf = LEAF.exec(text.trim());
  if (leaf) return { kind: "leaf", name: leaf[1], attrs: parseAttrs(leaf[2] ?? "") };
  const open = OPEN.exec(text.trim());
  if (open) return { kind: "open", name: open[1], attrs: parseAttrs(open[2] ?? "") };
  return null;
}

const COLON = 58;

/** The markdown syntax: LeafDirective, DirectiveOpen and DirectiveClose blocks, each with its marks, name and attributes. */
export const directiveSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "LeafDirective", block: true },
    { name: "DirectiveOpen", block: true },
    { name: "DirectiveClose", block: true },
    { name: "DirectiveMark", style: t.processingInstruction },
    { name: "DirectiveName", style: t.special(t.processingInstruction) },
    { name: "DirectiveAttributes", style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: "Directive",
      parse(cx, line) {
        if (line.next !== COLON) return false;
        const text = line.text.slice(line.pos);
        const from = cx.lineStart + line.pos;
        const end = cx.lineStart + line.text.length;
        if (CLOSE.test(text)) {
          cx.addElement(cx.elt("DirectiveClose", from, end, [cx.elt("DirectiveMark", from, from + 3)]));
          cx.nextLine();
          return true;
        }
        const m = OPEN.exec(text) ?? LEAF.exec(text);
        if (!m) return false;
        const colons = text.startsWith(":::") ? 3 : 2;
        const nameEnd = from + colons + m[1].length;
        const children = [cx.elt("DirectiveMark", from, from + colons), cx.elt("DirectiveName", from + colons, nameEnd)];
        if (m[2] !== undefined) children.push(cx.elt("DirectiveAttributes", nameEnd, nameEnd + m[2].length + 2));
        cx.addElement(cx.elt(colons === 3 ? "DirectiveOpen" : "LeafDirective", from, end, children));
        cx.nextLine();
        return true;
      },
      // A directive on the line after a paragraph's last line ends the paragraph, so it's still a directive.
      endLeaf: (_cx, line) => {
        const text = line.text.slice(line.pos);
        return LEAF.test(text) || OPEN.test(text) || CLOSE.test(text);
      },
      before: "FencedCode",
    },
  ],
};
