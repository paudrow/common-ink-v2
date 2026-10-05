// Where daily notes live: a folder (the "daily.folder" setting, Journal by default) with a note for each
// day, named by its date. The one definition: other extensions ask the Daily notes extension for it.

/** A day as YYYY-MM-DD where you are. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The folder as written in settings, tidied: no slashes at either end, Journal if it's blank. */
export const tidyFolder = (folder: string | undefined) => folder?.trim().replace(/^\/+|\/+$/g, "") || "Journal";

/** A day's note in `folder`. */
export const dailyPath = (folder: string, day: string) => `${tidyFolder(folder)}/${day}.md`;

/** The day a path is the daily note of, in `folder`, or null. */
export function dayOfPath(folder: string, path: string): string | null {
  const m = path.match(/^(.*)\/(\d{4}-\d{2}-\d{2})\.md$/);
  return m && m[1] === tidyFolder(folder) ? m[2] : null;
}

/** A new daily note's text: just its date, as its title. */
export const initialText = (day: string) => `# ${day}\n`;

/** The nearest day with a note before (-1) or after (1) `day`, among `days`, or null. */
export function nearestDay(days: string[], day: string, by: -1 | 1): string | null {
  const sorted = [...days].sort();
  return (by < 0 ? sorted.filter((d) => d < day).at(-1) : sorted.find((d) => d > day)) ?? null;
}

/** What the Daily notes extension offers others (ctx.extensions.api("daily")). */
export interface DailyNotes {
  /** Today, by the page's clock. */
  today(): string;
  /** A day's note's path. */
  pathFor(day: string): string;
  /** The day a path is the daily note of, or null. */
  dayOf(path: string): string | null;
  /** A new daily note's text. */
  initial(day: string): string;
}
