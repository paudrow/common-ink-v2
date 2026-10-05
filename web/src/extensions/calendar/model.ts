// The Calendar view's arithmetic, without a page: days, the periods each view shows and how they step,
// where an event sits in a day's column, and how a drag snaps. Days are "2026-10-05" strings counted
// in UTC, so a daylight-saving change never moves one; times of day are minutes from midnight.

export type View = "agenda" | "3day" | "week" | "month" | "year";
export const VIEWS: readonly View[] = ["agenda", "3day", "week", "month", "year"];

/** What each view is called, and the key that shows it (by the character typed, so any layout). */
export const VIEW_NAMES: Record<View, { label: string; key: string }> = {
  agenda: { label: "Agenda", key: "a" },
  "3day": { label: "3 days", key: "3" },
  week: { label: "Week", key: "w" },
  month: { label: "Month", key: "m" },
  year: { label: "Year", key: "y" },
};

export type Day = string;

const ms = (day: Day) => Date.parse(`${day}T00:00:00Z`);
const fromMs = (t: number): Day => new Date(t).toISOString().slice(0, 10);

export const addDays = (day: Day, n: number): Day => fromMs(ms(day) + n * 86_400_000);
export const daysBetween = (a: Day, b: Day) => Math.round((ms(b) - ms(a)) / 86_400_000);
/** 0 is Monday, 6 Sunday. */
export const weekday = (day: Day) => (new Date(ms(day)).getUTCDay() + 6) % 7;

export function addMonths(day: Day, n: number): Day {
  const d = new Date(ms(day));
  const index = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(index / 12);
  const m = index - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

export const startOfMonth = (day: Day): Day => `${day.slice(0, 8)}01`;
export const startOfYear = (day: Day): Day => `${day.slice(0, 4)}-01-01`;
/** The first day of `day`'s week, for weeks starting on `weekStart` (0 Monday … 6 Sunday). */
export const startOfWeek = (day: Day, weekStart: number): Day => addDays(day, -((weekday(day) - weekStart + 7) % 7));

/** A local Date's day. */
export const dayOf = (d: Date): Day => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A day's local midnight. */
export const midnight = (day: Day): Date => new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));

/** The days a view shows at once, starting where it starts for `anchor`. */
export function period(view: View, anchor: Day, weekStart: number): { start: Day; days: number } {
  switch (view) {
    case "3day":
      return { start: anchor, days: 3 };
    case "week":
      return { start: startOfWeek(anchor, weekStart), days: 7 };
    case "month":
      return { start: startOfMonth(anchor), days: daysBetween(startOfMonth(anchor), addMonths(startOfMonth(anchor), 1)) };
    case "year":
      return { start: startOfYear(anchor), days: daysBetween(startOfYear(anchor), `${+anchor.slice(0, 4) + 1}-01-01`) };
    case "agenda":
      return { start: anchor, days: 14 };
  }
}

/** The anchor `n` periods on: three days, a week, a month or a year (the agenda steps by a week). */
export function step(view: View, anchor: Day, n: number, weekStart: number): Day {
  switch (view) {
    case "3day":
      return addDays(anchor, 3 * n);
    case "week":
      return addDays(startOfWeek(anchor, weekStart), 7 * n);
    case "month":
      return addMonths(startOfMonth(anchor), n);
    case "year":
      return `${+anchor.slice(0, 4) + n}-01-01`;
    case "agenda":
      return addDays(anchor, 7 * n);
  }
}

/** The days shown at once, in the time grid: 3 or 7. */
export const gridDays = (view: View) => (view === "3day" ? 3 : 7);

/** What the toolbar says: "October 2026", "Oct 5 – 11, 2026", "Oct 30 – Nov 1, 2026", "2026". */
export function title(view: View, anchor: Day, weekStart: number, locale?: string): string {
  const fmt = (day: Day, o: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { ...o, timeZone: "UTC" });
  if (view === "year") return anchor.slice(0, 4);
  if (view === "month") return fmt(anchor, { month: "long", year: "numeric" });
  const { start, days } = view === "agenda" ? { start: anchor, days: 1 } : period(view, anchor, weekStart);
  const end = addDays(start, days - 1);
  if (view === "agenda") return fmt(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (start.slice(0, 7) === end.slice(0, 7)) return `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, { day: "numeric" })}, ${end.slice(0, 4)}`;
  if (start.slice(0, 4) === end.slice(0, 4)) return `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, { month: "short", day: "numeric" })}, ${end.slice(0, 4)}`;
  return `${fmt(start, { month: "short", day: "numeric", year: "numeric" })} – ${fmt(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

// ------------------------------------------------------------------ a day's column

/** An event's place in one day's column, in minutes from that day's midnight. */
export interface Span {
  id: string;
  start: number;
  end: number;
}

/** Where an event is drawn in its day: its column of how many, among the events it overlaps. */
export interface Placed extends Span {
  column: number;
  columns: number;
}

/** The shortest an event is drawn, so a five-minute event can still be seen and grabbed. */
export const MIN_DRAWN = 25;

/**
 * Overlapping events side by side. Events that overlap (as drawn) form a cluster; each takes the
 * first column free when it starts, and every event in a cluster is as narrow as its widest row.
 */
export function placeDay(spans: readonly Span[]): Placed[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const columns = Math.max(0, ...cluster.map((p) => p.column + 1));
    for (const p of cluster) p.columns = columns;
    out.push(...cluster);
    cluster = [];
  };
  for (const s of sorted) {
    const end = Math.max(s.end, s.start + MIN_DRAWN);
    if (s.start >= clusterEnd) close();
    const busy = new Set(cluster.filter((p) => Math.max(p.end, p.start + MIN_DRAWN) > s.start).map((p) => p.column));
    let column = 0;
    while (busy.has(column)) column++;
    cluster.push({ ...s, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  close();
  return out;
}

/** Minutes snapped to a step (15 by default), within a day. */
export const snap = (minutes: number, by = 15) => Math.max(0, Math.min(24 * 60, Math.round(minutes / by) * by));

/** "09:30" for minutes from midnight. */
export const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A drag that makes an event: every quarter hour it touched, either way, at least `least` minutes long. */
export function dragRange(from: number, to: number, least = 15): { start: number; end: number } {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const start = Math.max(0, Math.floor(a / 15) * 15);
  return { start, end: Math.min(24 * 60, Math.max(start + least, Math.ceil(b / 15) * 15)) };
}

// ------------------------------------------------------------------ months and years

/** A month as the month view draws it: whole weeks, from the week its first day is in. */
export function monthWeeks(month: Day, weekStart: number): Day[][] {
  const first = startOfWeek(startOfMonth(month), weekStart);
  const next = addMonths(startOfMonth(month), 1);
  const weeks: Day[][] = [];
  for (let day = first; day < next; day = addDays(day, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
  return weeks;
}

/** The days of the week in order from `weekStart`, as 0 Monday … 6 Sunday. */
export const weekdays = (weekStart: number) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
