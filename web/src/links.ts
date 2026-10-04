// Links between notes: [[Note name]] and markdown links to .md files, as `gd` follows them.
import { parseDocPath, type DocPath } from "../../worker/src/docs.ts";

const LINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)[^)]*\)/g;

/**
 * The note linked at `column` in a line of `from`. A [[name]] is from the top of the workspace; a
 * markdown link's path is relative to `from`'s folder. Null when the column isn't on a link to a note.
 */
export function noteLinkAt(line: string, column: number, from: DocPath): DocPath | null {
  for (const m of line.matchAll(LINK)) {
    if (column < m.index || column >= m.index + m[0].length) continue;
    if (m[1] !== undefined) return notePathFor(m[1]);
    const href = m[2].replace(/^<|>$/g, "");
    try {
      return notePathFor(decodeURIComponent(href), from);
    } catch {
      return null;
    }
  }
  return null;
}

/** The note a name points to: "Ideas" and "Ideas.md" are both Ideas.md. Null for URLs and non-notes. */
export function notePathFor(name: string, from?: DocPath): DocPath | null {
  let target = name.trim().split("#")[0];
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (!target.endsWith(".md")) target += ".md";
  const parts = target.startsWith("/") || !from ? [] : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parseDocPath(parts.join("/"));
}
