// Tags as tasks write them: `#work/clients` nests with `/`, and a filter on `work` matches it and every
// tag under it. Matching ignores case; notes keep whatever form the person typed.

/** One tag found in a line: `from`/`to` are the columns of its text, without the `#`. */
export interface TagHit {
  /** Lowercased, for matching. */
  tag: string;
  /** As written (slashes tidied). */
  display: string;
  from: number;
  to: number;
}

const SEGMENT = "[\\p{L}\\p{N}_-]+";
const SHAPE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, "u");
/** `#word` at the start of a line or after whitespace: not `page#section`, `a#b` or `\#escaped`. */
const INLINE = /(?<!\S)#([\p{L}\p{N}_/-]+)/gu;

/** A line with its code spans blanked out (same length), so nothing in code counts. */
export const withoutCode = (line: string) => line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
/** A line with its code spans and [[links]] blanked out (same length). */
export const withoutCodeOrLinks = (line: string) => withoutCode(line).replace(/\[\[[^[\]\n]*\]\]/g, (s) => " ".repeat(s.length));

/** A tag as written, tidied ("#Work//Acme/" → "Work/Acme"), or null if it isn't one. Needs a letter, so `#27` isn't a tag. */
export function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  return SHAPE.test(t) && /\p{L}/u.test(t) ? t : null;
}

/** The form tags are matched by, or null if it isn't one. */
export const normalizeTag = (raw: string) => cleanTag(raw)?.toLowerCase() ?? null;

/** Does `tag` fall under `filter` (both normalized)? `work` matches `work` and `work/acme`, not `workshop`. */
export const tagMatches = (tag: string, filter: string) => tag === filter || tag.startsWith(`${filter}/`);

/** The inline `#tags` on one line. Code spans and [[links]] don't count. */
export function tagsInLine(line: string): TagHit[] {
  const out: TagHit[] = [];
  for (const m of withoutCodeOrLinks(line).matchAll(INLINE)) {
    let end = m[1].length;
    while (end > 0 && m[1][end - 1] === "/") end--; // a loop: /\/+$/ is quadratic on a long run of slashes
    const text = m[1].slice(0, end);
    const display = cleanTag(text);
    if (!display) continue;
    const from = m.index + 1;
    out.push({ tag: display.toLowerCase(), display, from, to: from + text.length });
  }
  return out;
}

/** A heading's words, without closing #s. */
export const headingText = (rest: string) => rest.replace(/\s+#+\s*$/, "").trim();
