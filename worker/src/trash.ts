// Trash's rules, one place for the operations and the Durable Object's daily purge: how long a deleted
// note stays (trash.retentionDays, a workspace setting), and which have been there longer.
import { RETENTION, type Deleted, type FilePath, type Files } from "./files.ts";
import { parseSettings, SETTINGS, WORKSPACE_SETTINGS } from "./settings.ts";

export const DAY = 86_400_000;

/** How many days deleted notes stay in Trash, from the workspace settings file's text. */
export function retentionDays(workspaceSettings: string): number {
  return (parseSettings(workspaceSettings).settings["trash.retentionDays"] as number | undefined) ?? SETTINGS["trash.retentionDays"].default;
}

/** Notes in Trash: deleted within the last `days`. Other files deleted are in history, not Trash. */
export const inTrash = (deleted: readonly Deleted[], days: number, now: number) => deleted.filter((d) => d.path.endsWith(".md") && d.time >= now - days * DAY);

/** Notes deleted longer ago than `days`: what the daily purge takes. */
export const expired = (deleted: readonly Deleted[], days: number, now: number): FilePath[] => deleted.filter((d) => d.path.endsWith(".md") && d.time < now - days * DAY).map((d) => d.path);

/** Purge the notes that have been in Trash longer than trash.retentionDays, as changes by Trash retention. */
export function purgeExpired(files: Files, now: number) {
  const days = retentionDays(files.read(WORKSPACE_SETTINGS)?.text ?? "");
  return files.purge(expired(files.deleted(0), days, now), RETENTION);
}
