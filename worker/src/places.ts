// Places (CONTEXT.md): where you can go in the app. Extensions add theirs (contributes.places); which
// three a phone's bottom bar holds is yours, in .common-ink/places.json, read here leniently, so a
// half-written file still leaves a bar. The file can hold more (order, saved searches): it's kept as it is.
import { parseFilePath } from "./files.ts";

export const PLACES_PATH = parseFilePath(".common-ink/places.json")!;

/** The bottom bar's places when places.json doesn't say (decision 6): the Feed, then Daily notes' Today and Calendar's. An extension's place is named `<extension id>.<place id>`. */
export const DEFAULT_BAR: readonly string[] = ["feed", "daily.today", "calendar.calendar"];

/** How many places the bottom bar holds, beside Search and Places. */
export const BAR_SIZE = 3;

/** The bottom bar's place ids, from places.json's text: its "bar", or the default. */
export function barOf(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [...DEFAULT_BAR];
  }
  const bar = (data as { bar?: unknown } | null)?.bar;
  if (!Array.isArray(bar)) return [...DEFAULT_BAR];
  return [...new Set(bar.filter((id): id is string => typeof id === "string" && !!id))].slice(0, BAR_SIZE);
}
