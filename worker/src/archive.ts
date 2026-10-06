// The archive: notes you're done with but keep. Archiving doesn't move or change a note; its path goes in
// .common-ink/archive.json, so archiving is a change to that file, with an author, that undo takes back
// (ADR 0002), and links, labels and history are untouched. One path per line, sorted, so a diff says
// exactly what was archived.
//
// The file is a set, and it's merged as one: a write based on an older version, or an undo, keeps every
// other path's archiving as it is now and changes only the paths it changed. So undoing one archive
// never clashes with another, from an agent or another tab. A note's archiving ends with the note:
// deleting it takes its path out, in the same transaction.
import { isNote, parseFilePath, type FilePath, type Files, type Write, type WriteResult } from "./files.ts";

export const ARCHIVE_PATH = parseFilePath(".common-ink/archive.json")!;

/** The archive file, read: the archived notes' paths, entries that aren't notes' paths (kept as they are), and its other keys. */
export interface Archive {
  archived: FilePath[];
  others: unknown[];
  rest: Record<string, unknown>;
}

/** The archive in a file's text, or null if it isn't valid JSON with an `archived` list. An empty file is an empty archive. */
export function readArchive(text: string): Archive | null {
  let data: unknown;
  try {
    data = JSON.parse(text.trim() ? text : "{}");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { archived = [], ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(archived)) return null;
  const notes = (p: unknown): p is FilePath => !!parseFilePath(p) && isNote(p as FilePath);
  return { archived: [...new Set(archived.filter(notes))].sort(), others: archived.filter((p) => !notes(p)), rest };
}

/** The archived paths in the archive file's text; none if it can't be read. */
export const parseArchive = (text: string): FilePath[] => readArchive(text)?.archived ?? [];

export function archiveText(archive: Archive): string {
  return `${JSON.stringify({ ...archive.rest, archived: [...[...new Set(archive.archived)].sort(), ...archive.others] }, null, 2)}\n`;
}

/** The archive with `paths` archived, or taken out of it. */
export function withArchived(current: Archive, paths: readonly FilePath[], archived: boolean): Archive {
  const set = new Set(current.archived);
  for (const p of paths) archived ? set.add(p) : set.delete(p);
  return { ...current, archived: [...set].sort() };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of archive files as sets: theirs, with what mine archived and unarchived since base.
 * Other keys take mine where mine changed them, else theirs. Null if a side can't be read.
 */
export function mergeArchive(mine: string, base: string, theirs: string): string | null {
  const [m, b, t] = [readArchive(mine), readArchive(base), readArchive(theirs)];
  if (!m || !b || !t) return null;
  const added = m.archived.filter((p) => !b.archived.includes(p));
  const removed = b.archived.filter((p) => !m.archived.includes(p));
  const keys = new Set([...Object.keys(m.rest), ...Object.keys(b.rest), ...Object.keys(t.rest)]);
  const rest = Object.fromEntries(
    [...keys].flatMap((k) => {
      const v = same(m.rest[k], b.rest[k]) ? t.rest[k] : m.rest[k];
      return v === undefined ? [] : [[k, v]];
    }),
  );
  const archived = [...new Set([...t.archived, ...added])].filter((p) => !removed.includes(p));
  return archiveText({ archived, others: same(m.others, b.others) ? t.others : m.others, rest });
}

/**
 * Delete a note, and take it out of the archive in the same transaction, so a note made later at its
 * path starts out unarchived. An archive file that can't be read is left as it is.
 */
export function deleteNote(files: Files, w: Write): WriteResult {
  return files.atomically(() => {
    const result = files.write({ ...w, delete: true });
    if (result.status === "conflict") return result;
    const file = files.read(ARCHIVE_PATH);
    const archive = readArchive(file?.text ?? "");
    if (file && archive?.archived.includes(w.path)) files.write({ path: ARCHIVE_PATH, text: archiveText(withArchived(archive, [w.path], false)), base: file.revision, author: w.author });
    return result;
  });
}
