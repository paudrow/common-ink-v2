// Events in search (contributes.search): an event matches the query's words in its title or where it
// is. Events have none of the filters notes do, so a query with one finds no events.
import { matchesWords, type Query } from "common-ink/query";
import type { Occurrence } from "../../../../worker/src/calendar.ts";

/** How far search looks for events, back and ahead of now. */
export const SEARCH_BACK = 30 * 86_400_000;
export const SEARCH_AHEAD = 365 * 86_400_000;

/**
 * The events a query finds among occurrences: a repeating event once, at its next time. Coming ones
 * first, soonest first, then past ones, latest first.
 */
export function findEvents(occurrences: readonly Occurrence[], query: Query, now: number): Occurrence[] {
  if (query.terms.some((t) => t.kind === "filter" && t.value)) return [];
  const at = (o: Occurrence) => Date.parse(o.allDay ? `${o.end}T00:00:00` : o.end);
  const coming = (o: Occurrence) => at(o) >= now;
  const best = new Map<string, Occurrence>();
  for (const o of occurrences) {
    if (!matchesWords(query, `${o.title}\n${o.location ?? ""}`)) continue;
    const key = o.series ?? o.address;
    const kept = best.get(key);
    // A series is shown at its next occurrence, or its last one if none are coming.
    if (!kept || (coming(o) && (!coming(kept) || o.start < kept.start)) || (!coming(o) && !coming(kept) && o.start > kept.start)) best.set(key, o);
  }
  return [...best.values()].sort((a, b) => Number(coming(b)) - Number(coming(a)) || (coming(a) ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start)));
}
