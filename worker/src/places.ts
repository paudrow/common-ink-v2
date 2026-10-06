// Places (CONTEXT.md): where you can go in the app. Extensions add theirs (contributes.places); which
// three a phone's bottom bar holds is yours, in .common-ink/places.json, read here leniently, so a
// half-written file still leaves a bar. The file can hold more (order, saved searches): it's kept as it is.
import { parseFilePath } from "./files.ts";

export const PLACES_PATH = parseFilePath(".common-ink/places.json")!;

/** The bottom bar's places when places.json doesn't say (decision 6): the Feed, then Daily notes' Today and Calendar's. An extension's place is named `<extension id>.<place id>`. */
export const DEFAULT_BAR: readonly string[] = ["feed", "daily.today", "calendar.calendar"];

/** How many places the bottom bar holds, beside Search and Places. */
export const BAR_SIZE = 3;

/** Places' ids before they were named for their extensions, as places.json may still have them. */
const RENAMED: Readonly<Record<string, string>> = {
  today: "daily.today",
  calendar: "calendar.calendar",
  tasks: "tasks.tasks",
  sources: "data-sources.sources",
  contacts: "contacts.contacts",
  uploads: "uploads.uploads",
};

/**
 * The bottom bar's place ids, from places.json's text: its "bar", or the default. Every id it names is
 * kept, in order, places that aren't there now (an extension turned off) included, so turning one back
 * on puts its place back; the bar shows the first three that are places now.
 */
export function barOf(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [...DEFAULT_BAR];
  }
  const bar = (data as { bar?: unknown } | null)?.bar;
  if (!Array.isArray(bar)) return [...DEFAULT_BAR];
  return [...new Set(bar.filter((id): id is string => typeof id === "string" && !!id).map((id) => RENAMED[id] ?? id))];
}

/** What the bar shows, of the ids it keeps: the first three that are places now. */
export const shownOnBar = (bar: readonly string[], places: ReadonlySet<string>) => bar.filter((id) => places.has(id)).slice(0, BAR_SIZE);
