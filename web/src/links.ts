// Links between notes: [[Note name]] and markdown links to .md files, as `gd` follows them.
import { parseFilePath, type FilePath } from "../../worker/src/files.ts";

const LINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)[^)]*\)/g;

/**
 * The note linked at `column` in a line of `from`. A [[name]] is from the top of the workspace; a
 * markdown link's path is relative to `from`'s folder. Null when the column isn't on a link to a note.
 */
export function noteLinkAt(line: string, column: number, from: FilePath): FilePath | null {
  const target = linkAt(line, column, from);
  return target && "note" in target ? target.note : null;
}

/** What a link's target opens: a note in the workspace, or a page (a web address or an upload) in a new browser tab. */
export type LinkTarget = { note: FilePath } | { url: string };

/** What a link's target (a [[name]] or a markdown link's href) opens, from `from`. Null if nothing. */
export function linkTarget(href: string, from: FilePath | null): LinkTarget | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.trim());
  } catch {
    decoded = href.trim();
  }
  if (/^(https?:\/\/|\/uploads\/)/i.test(href.trim())) return { url: href.trim() };
  const note = notePathFor(decoded, from ?? undefined);
  return note ? { note } : null;
}

/** The target of the link at `column` in a line, whatever it is. */
export function linkAt(line: string, column: number, from: FilePath): LinkTarget | null {
  for (const m of line.matchAll(LINK)) {
    if (column < m.index || column >= m.index + m[0].length) continue;
    if (m[1] !== undefined) return linkTarget(m[1], null);
    return linkTarget(m[2].replace(/^<|>$/g, ""), from);
  }
  return null;
}

/** The note a name points to: "Ideas" and "Ideas.md" are both Ideas.md. Null for URLs and non-notes. */
export function notePathFor(name: string, from?: FilePath): FilePath | null {
  let target = name.trim().split("#")[0];
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (!target.endsWith(".md")) target += ".md";
  const parts = target.startsWith("/") || !from ? [] : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parseFilePath(parts.join("/"));
}
