// The archive: notes you're done with but keep. Archiving doesn't move or change a note; its path goes in
// .common-ink/archive.json, so archiving is a change to that file, with an author, that undo takes back
// (ADR 0002), and links, labels and history are untouched. One path per line, sorted, so a diff says
// exactly what was archived.
import { isNote, parseFilePath, type FilePath } from "./files.ts";

export const ARCHIVE_PATH = parseFilePath(".common-ink/archive.json")!;

/** The archived paths in the archive file's text. Anything that isn't a note's path is skipped. */
export function parseArchive(text: string): FilePath[] {
  let data: unknown;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    return [];
  }
  const list = (data as { archived?: unknown })?.archived;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.flatMap((p) => (parseFilePath(p) && isNote(p as FilePath) ? [p as FilePath] : [])))].sort();
}

export function archiveText(paths: Iterable<FilePath>): string {
  return `${JSON.stringify({ archived: [...new Set(paths)].sort() }, null, 2)}\n`;
}

/** The archive with `paths` archived, or taken out of it. */
export function withArchived(current: readonly FilePath[], paths: readonly FilePath[], archived: boolean): FilePath[] {
  const set = new Set(current);
  for (const p of paths) archived ? set.add(p) : set.delete(p);
  return [...set].sort();
}
