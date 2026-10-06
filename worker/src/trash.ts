// Trash's rules, one place for the operations and the Durable Object: how long a deleted note stays
// (trash.retentionDays, a workspace setting), which deletes are in Trash, and restoring one.
import { ARCHIVE_PATH, archiveText, readArchive, withArchived } from "./archive.ts";
import { isNote, parseFilePath, RETENTION, type Author, type Deleted, type FilePath, type Files, type Revision } from "./files.ts";
import { parseSettings, SETTINGS, WORKSPACE_SETTINGS } from "./settings.ts";

export const DAY = 86_400_000;

/** The trash.retentionDays a workspace settings file's text sets: a whole number of days in range, or the default. */
export function retentionDays(workspaceSettings: string): number {
  return (parseSettings(workspaceSettings).settings["trash.retentionDays"] as number | undefined) ?? SETTINGS["trash.retentionDays"].default;
}

/**
 * How long deleted notes stay in Trash: the trash.retentionDays a person last set. Only a person may
 * change it (operations.ts refuses others), and a value anyone else wrote, by any route, is never used,
 * so no agent can make Trash retention purge a person's notes sooner.
 */
export function retentionOf(files: Files): number {
  let before = SETTINGS["trash.retentionDays"].default;
  let set = before;
  for (const { change, text } of files.versions(WORKSPACE_SETTINGS)) {
    const now = retentionDays(change.deleted ? "" : text);
    if (now !== before && change.author.kind === "user") set = now;
    before = now;
  }
  return set;
}

/** Notes in Trash: deleted within the last `days`. Other files deleted are in history, not Trash. */
export const inTrash = (deleted: readonly Deleted[], days: number, now: number) => deleted.filter((d) => isNote(d.path) && d.time >= now - days * DAY);

/** How many "(restored N)" names Restore tries beside a taken path before it says there's no free name. */
const MAX_RESTORED = 100;

/** The longest a path can be (parseFilePath). */
const MAX_PATH = 300;

/**
 * Where a restored note goes: its own path while that's free, else "<name> (restored).md", then
 * "(restored 2)" and on, the name shortened to fit a path's length. Null when none of those is free,
 * or no name fits under its folder.
 */
export function restoredPath(files: Files, path: FilePath): FilePath | null {
  if (!files.read(path)) return path;
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const name = [...path.slice(folder.length).replace(/\.md$/, "")];
  for (let n = 1; n <= MAX_RESTORED; n++) {
    const suffix = ` (restored${n > 1 ? ` ${n}` : ""}).md`;
    const kept = [...name];
    while (kept.length && folder.length + kept.join("").length + suffix.length > MAX_PATH) kept.pop();
    const stem = kept.join("").trimEnd();
    if (!stem) return null;
    const next = parseFilePath(`${folder}${stem}${suffix}`);
    if (next && !files.read(next)) return next;
  }
  return null;
}

/**
 * Bring a note in Trash back, in one transaction. At its own path, if that's free, by undoing its
 * delete, so it comes back with its whole history; if another note has the path now, as a new note
 * beside it that records which delete it undoes. If it was archived when it was deleted, it's archived again.
 */
export function restoreFromTrash(files: Files, d: Deleted, author: Author): { path: FilePath; revision: Revision } | { error: string } {
  return files.atomically(() => {
    const path = restoredPath(files, d.path);
    if (!path) return { error: `There's no free name to restore ${d.path} beside the note there now: rename or move that note, then restore again` };
    let revision: Revision;
    if (path === d.path) {
      const [undone] = files.undo([d.revision], author);
      if (undone.status !== "undone" || !undone.file) throw new Error(`${d.path} couldn't be restored (${undone.status})`);
      revision = undone.file.revision;
    } else {
      const result = files.write({ path, text: files.versionAt(d.path, d.before) ?? "", base: 0, author, undoes: d.revision });
      if (result.status === "conflict") throw new Error(`${path} couldn't be written`);
      revision = result.file.revision;
    }
    const wasArchived = readArchive(files.textBefore(ARCHIVE_PATH, d.revision))?.archived.includes(d.path);
    const file = files.read(ARCHIVE_PATH);
    const now = readArchive(file?.text ?? "");
    if (wasArchived && now && !now.archived.includes(path)) files.write({ path: ARCHIVE_PATH, text: archiveText(withArchived(now, [path], true)), base: file?.revision ?? 0, author });
    return { path, revision };
  });
}

/** Notes deleted longer ago than `days`: what the daily purge takes. Only revisions and times are read. */
export const expired = (files: Files, days: number, now: number): Revision[] => files.deleted(0, now - days * DAY).filter((d) => isNote(d.path)).map((d) => d.revision);

/** Purge the notes that have been in Trash longer than trash.retentionDays, as changes by Trash retention. */
export function purgeExpired(files: Files, now: number) {
  return files.purge(expired(files, retentionOf(files), now), RETENTION);
}
