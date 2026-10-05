// Calendar events as Common Ink keeps them: one record per event, series or changed occurrence, in
// any data source's calendar (Google's, the Sample calendar). A series keeps its RRULE, and its
// occurrences are worked out here for whatever days are asked for, so a series that never ends costs
// one record. An occurrence someone changed or cancelled is a record of its own, as Google keeps it.
//
// Times are wall times ("2026-10-05T09:00") in the event's time zone. An event without one is
// floating: it happens at that wall time wherever the person looking at it is, as all-day events do.
import { parseRule, ruleDays } from "./recurrence.ts";

/** A calendar day, "2026-10-05". */
export type Day = string;
/** A wall time, "2026-10-05T09:00" or "2026-10-05T09:00:30". */
export type WallTime = string;

/** When an event happens. An all-day event's end is the day after its last day, as in iCalendar. */
export type EventTiming = { allDay: true; start: Day; end: Day } | { allDay: false; start: WallTime; end: WallTime; timeZone?: string };

/** How an event repeats: not at all, as a series (its RRULE, EXDATE and RDATE lines), or as a changed occurrence of one. */
export type EventRepeat =
  | { recurrence?: undefined; series?: undefined; originalStart?: undefined }
  | { recurrence: string[]; series?: undefined; originalStart?: undefined }
  | { series: string; originalStart: Day | WallTime; recurrence?: undefined };

export interface EventFields {
  /** Its id in its source. An occurrence's is its series' id, "_" and its original start, as Google writes it. */
  id: string;
  calendar: string;
  title: string;
  location?: string;
  description?: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** One of the source's event colours, if it isn't its calendar's. */
  colorId?: string;
  /** Where to open it in its source, if it has a page there. */
  link?: string;
}

export type CalendarEvent = EventFields & EventTiming & EventRepeat;

/** A calendar a source has. */
export interface Calendar {
  id: string;
  title: string;
  /** "#rrggbb". */
  color: string;
  primary?: boolean;
  /** Whether events can be added and changed in it. */
  writable: boolean;
  /** Its own time zone, for events made in it. */
  timeZone?: string;
}

/** One time an event happens, in the days asked for: what a calendar draws and what agents list. */
export interface Occurrence {
  /** The record a note links to: the occurrence's own for a series, else the event's. */
  address: string;
  id: string;
  calendar: string;
  title: string;
  location?: string;
  description?: string;
  status: "confirmed" | "tentative";
  colorId?: string;
  link?: string;
  allDay: boolean;
  /** An instant ("2026-10-05T16:00:00.000Z"), or a day for an all-day event. */
  start: string;
  end: string;
  /** The event's own time zone, if it has one. */
  timeZone?: string;
  /** For an occurrence of a series: the series' id, and whether this one was changed on its own. */
  series?: string;
  changed?: boolean;
}

// ------------------------------------------------------------------ time zones

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formats.set(zone, f);
  }
  return f;
}

/** Whether a time zone name is one this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    format(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall time an instant is in a zone, to the second. */
export function wallTimeAt(ms: number, zone: string): WallTime {
  const parts = Object.fromEntries(format(zone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

const naiveMs = (wall: WallTime) => Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
/** A wall time moved by some ms, as a clock would read it (no zone, so no daylight-saving jump). */
const wallPlus = (wall: WallTime, ms: number): WallTime => new Date(naiveMs(wall) + ms).toISOString().slice(0, 19);

/**
 * The instant a wall time is in a zone. A wall time a clock skips (2:30 on the night clocks go
 * forward) is read as an hour later; one it repeats is the first of the two.
 */
export function instantOf(wall: WallTime, zone: string): number {
  const naive = naiveMs(wall);
  const offset = (at: number) => naiveMs(wallTimeAt(at, zone)) - at;
  const before = naive - offset(naive - 86_400_000);
  const after = naive - offset(naive + 86_400_000);
  const reads = (t: number) => naiveMs(wallTimeAt(t, zone)) === naive;
  if (reads(before) && reads(after)) return Math.min(before, after);
  if (reads(after)) return after;
  return before;
}

const addDays = (day: Day, n: number): Day => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: Day, b: Day) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** An event's start or end as an instant, in its zone or, floating, the viewer's. */
const instant = (wall: WallTime, zone: string | undefined, viewer: string) => instantOf(wall, zone ?? viewer);

const zForm = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const compact = (wall: Day | WallTime) => wall.replace(/[-:]/g, "");

/**
 * How an occurrence's original start is written in its id, as Google writes it: "20261005T160000Z"
 * (in UTC) for an event with a zone, "20261005" for a day. A floating event's is its wall time
 * ("20261005T090000"), so its id is the same wherever it's seen from.
 */
export function basicStart(start: Day | WallTime, zone: string | undefined): string {
  if (start.length === 10 || !zone) return compact(start);
  return zForm(instantOf(start, zone));
}

/** An occurrence's original start from its id's, as a day or a wall time in the series' zone (or the viewer's, for a UTC one that floats). */
function startOfBasic(basic: string, zone: string | undefined, viewer: string): Day | WallTime {
  const wall = basic.length === 8 ? `${basic.slice(0, 4)}-${basic.slice(4, 6)}-${basic.slice(6, 8)}` : `${basic.slice(0, 4)}-${basic.slice(4, 6)}-${basic.slice(6, 8)}T${basic.slice(9, 11)}:${basic.slice(11, 13)}:${basic.slice(13, 15)}`;
  return basic.endsWith("Z") ? wallTimeAt(Date.parse(`${wall}Z`), zone ?? viewer) : wall;
}

// ------------------------------------------------------------------ reading events

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WALL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/;

/** A wall time with its seconds, so wall times compare as text. */
export const fullWall = (v: string): WallTime | null => {
  const m = WALL.exec(v);
  return m && !Number.isNaN(naiveMs(v)) ? `${m[1]}${m[2] ?? ":00"}` : null;
};

const text = (v: unknown, max = 10_000) => (typeof v === "string" && v.length <= max ? v : undefined);

/**
 * An event from JSON (a record file, or what an agent sent), or what's wrong with it. Wall times get
 * their seconds; anything not part of an event is dropped.
 */
export function parseEvent(raw: unknown): CalendarEvent | string {
  if (!raw || typeof raw !== "object") return "An event is a JSON object";
  const r = raw as Record<string, unknown>;
  const id = text(r.id, 1024);
  const calendar = text(r.calendar, 1024);
  if (!id || !calendar) return 'An event needs an "id" and a "calendar"';
  const timing = parseTiming(r);
  if (typeof timing === "string") return timing;
  const status = r.status === undefined ? "confirmed" : r.status;
  if (status !== "confirmed" && status !== "tentative" && status !== "cancelled") return '"status" is confirmed, tentative or cancelled';
  const fields: EventFields = { id, calendar, title: text(r.title, 1000) ?? "", status };
  for (const key of ["location", "description", "colorId", "link"] as const) {
    const v = text(r[key]);
    if (v) fields[key] = v;
  }
  if (Array.isArray(r.recurrence) && r.recurrence.length) {
    if (!r.recurrence.every((l) => typeof l === "string" && /^(RRULE|EXDATE|RDATE)[:;]/i.test(l))) return '"recurrence" holds RRULE, EXDATE and RDATE lines';
    return { ...fields, ...timing, recurrence: r.recurrence as string[] };
  }
  if (typeof r.series === "string") {
    const original = typeof r.originalStart === "string" ? (timing.allDay ? (DAY.test(r.originalStart) ? r.originalStart : null) : fullWall(r.originalStart)) : null;
    if (!original) return '"originalStart" is the start this occurrence replaces, written as its "start" is';
    return { ...fields, ...timing, series: r.series, originalStart: original };
  }
  return { ...fields, ...timing };
}

/** An event's times from JSON: days for an all-day event, wall times (and perhaps a zone) otherwise. */
export function parseTiming(r: Record<string, unknown>): EventTiming | string {
  if (r.allDay === true) {
    if (typeof r.start !== "string" || !DAY.test(r.start) || typeof r.end !== "string" || !DAY.test(r.end)) return "An all-day event's start and end are days, like 2026-10-05";
    return r.end > r.start ? { allDay: true, start: r.start, end: r.end } : "An all-day event ends on a later day than it starts (the day after its last)";
  }
  const start = typeof r.start === "string" ? fullWall(r.start) : null;
  const end = typeof r.end === "string" ? fullWall(r.end) : null;
  if (!start || !end) return 'A timed event\'s start and end are wall times, like 2026-10-05T09:00 (set "allDay": true for days)';
  if (end < start) return "An event can't end before it starts";
  if (r.timeZone !== undefined && (typeof r.timeZone !== "string" || !isTimeZone(r.timeZone))) return `"${String(r.timeZone)}" isn't a time zone, like America/New_York`;
  return { allDay: false, start, end, ...(r.timeZone ? { timeZone: r.timeZone as string } : {}) };
}

// ------------------------------------------------------------------ series

/** A series' recurrence lines, read: its rule, the starts it skips, and starts it adds. */
interface Recurrence {
  rule: string | null;
  /** UNTIL as an instant (timed) or a day (all-day), taken out of the rule so it can be exact. */
  until: number | Day | null;
  skip: Set<string>;
  add: string[];
}

/** iCalendar date values ("20261012", "20261012T090000", "20261012T160000Z") as basic starts. */
function datesIn(line: string, timed: boolean, zone: string | undefined, viewer: string): string[] {
  const [head, value = ""] = line.split(/:(.*)/s);
  const tzid = /TZID=([^;:]+)/.exec(head)?.[1];
  return value.split(",").flatMap((v) => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
    if (!m) return [];
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (!m[4]) return timed ? [] : [compact(day)];
    const wall = `${day}T${m[4]}:${m[5]}:${m[6]}`;
    // Written in UTC or another zone: the same instant, written as the series writes its starts.
    const at = m[7] ? Date.parse(`${wall}Z`) : tzid && tzid !== zone ? instantOf(wall, tzid) : null;
    if (at === null) return [basicStart(wall, zone)];
    return [zone ? zForm(at) : compact(wallTimeAt(at, viewer))];
  });
}

function readRecurrence(lines: string[], timed: boolean, zone: string | undefined, viewer: string): Recurrence {
  const out: Recurrence = { rule: null, until: null, skip: new Set(), add: [] };
  for (const line of lines) {
    const name = line.split(/[:;]/)[0].toUpperCase();
    if (name === "RRULE" && !out.rule) {
      const parts = line.slice(6).split(";");
      const until = parts.find((p) => p.toUpperCase().startsWith("UNTIL="))?.slice(6);
      out.rule = `RRULE:${parts.filter((p) => !p.toUpperCase().startsWith("UNTIL=")).join(";")}`;
      const m = until && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
      if (m) {
        const day = `${m[1]}-${m[2]}-${m[3]}`;
        out.until = !timed ? day : m[4] ? (m[7] ? Date.parse(`${day}T${m[4]}:${m[5]}:${m[6]}Z`) : instant(`${day}T${m[4]}:${m[5]}:${m[6]}`, zone, viewer)) : instant(`${day}T23:59:59`, zone, viewer);
      }
    } else if (name === "EXDATE") for (const d of datesIn(line, timed, zone, viewer)) out.skip.add(d);
    else if (name === "RDATE") out.add.push(...datesIn(line, timed, zone, viewer));
  }
  return out;
}

/**
 * The starts a series has from its first through `last` (a day in its zone), as basic starts with
 * their wall times. A rule this can't read gives only the series' own first start.
 */
function seriesStarts(series: CalendarEvent & { recurrence: string[] }, last: Day, viewer: string): Array<{ basic: string; start: Day | WallTime }> {
  const timed = !series.allDay;
  const zone = series.allDay ? undefined : series.timeZone;
  const rec = readRecurrence(series.recurrence, timed, zone, viewer);
  const firstDay = series.start.slice(0, 10);
  const timeOfDay = series.start.slice(10);
  const rule = rec.rule ? parseRule(rec.rule) : null;
  const days = rule ? ruleDays(rule, firstDay, typeof rec.until === "string" && rec.until < last ? rec.until : last) : [firstDay];
  const out = days.map((day) => {
    const start = `${day}${timeOfDay}`;
    return { basic: basicStart(start, zone), start };
  });
  for (const basic of rec.add) if (!out.some((o) => o.basic === basic)) out.push({ basic, start: startOfBasic(basic, zone, viewer) });
  return out
    .filter((o) => !rec.skip.has(o.basic))
    .filter((o) => typeof rec.until !== "number" || o.start.length === 10 || instant(o.start, zone, viewer) <= rec.until)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** An occurrence's id: its series' id and its original start. */
export const occurrenceId = (series: string, basic: string) => `${series}_${basic}`;

/** The series id and original start in an occurrence's id, or null if it isn't one. */
export function splitOccurrenceId(id: string): { series: string; basic: string } | null {
  const m = /^(.+)_(\d{8}(?:T\d{6}Z?)?)$/.exec(id);
  return m ? { series: m[1], basic: m[2] } : null;
}

// ------------------------------------------------------------------ occurrences

export interface Range {
  /** Instants, ms. */
  from: number;
  to: number;
  /** The viewer's time zone: for floating times, and for which days all-day events fall on. */
  zone: string;
}

/** An event's span as instants, for overlap: all-day and floating ones in the viewer's zone. */
function span(e: EventTiming, viewer: string): [number, number] {
  if (e.allDay) return [instantOf(`${e.start}T00:00`, viewer), instantOf(`${e.end}T00:00`, viewer)];
  return [instant(e.start, e.timeZone, viewer), instant(e.end, e.timeZone, viewer)];
}

function toOccurrence(e: CalendarEvent, address: (id: string) => string, viewer: string, extra: Partial<Occurrence> = {}): Occurrence {
  const [from, to] = span(e, viewer);
  return {
    address: address(e.id),
    id: e.id,
    calendar: e.calendar,
    title: e.title,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    status: e.status === "tentative" ? "tentative" : "confirmed",
    ...(e.colorId ? { colorId: e.colorId } : {}),
    ...(e.link ? { link: e.link } : {}),
    allDay: e.allDay,
    start: e.allDay ? e.start : new Date(from).toISOString(),
    end: e.allDay ? e.end : new Date(to).toISOString(),
    ...(!e.allDay && e.timeZone ? { timeZone: e.timeZone } : {}),
    ...extra,
  };
}

/**
 * Every time the events happen in a range, in order: single events, each series' occurrences, and
 * occurrences changed on their own in place of the ones they replace. Cancelled ones are left out.
 * `address` names an event's record from its id.
 */
export function occurrences(events: readonly CalendarEvent[], range: Range, address: (calendar: string, id: string) => string): Occurrence[] {
  const viewer = range.zone;
  const overlaps = (e: EventTiming) => {
    const [from, to] = span(e, viewer);
    return from < range.to && (to > range.from || (from === to && from >= range.from));
  };
  const changed = new Map<string, CalendarEvent>();
  for (const e of events) if (e.series !== undefined) changed.set(occurrenceId(e.series, basicStart(e.originalStart, e.allDay ? undefined : e.timeZone)), e);
  const out: Occurrence[] = [];
  const lastDay = addDays(wallTimeAt(range.to, viewer).slice(0, 10), 1);
  for (const e of events) {
    if (e.status === "cancelled") continue;
    const at = (id: string) => address(e.calendar, id);
    if (e.series !== undefined) {
      if (overlaps(e)) out.push(toOccurrence(e, at, viewer, { series: e.series, changed: true }));
    } else if (e.recurrence) {
      const length = e.allDay ? dayDiff(e.start, e.end) : naiveMs(e.end) - naiveMs(e.start);
      for (const { basic, start } of seriesStarts(e as CalendarEvent & { recurrence: string[] }, lastDay, viewer)) {
        const id = occurrenceId(e.id, basic);
        if (changed.has(id)) continue;
        const timing: EventTiming = e.allDay
          ? { allDay: true, start, end: addDays(start, length) }
          : { allDay: false, start, end: wallPlus(start, length), ...(e.timeZone ? { timeZone: e.timeZone } : {}) };
        if (!overlaps(timing)) continue;
        out.push(toOccurrence({ ...e, ...timing, id, recurrence: undefined } as CalendarEvent, at, viewer, { series: e.id }));
      }
    } else if (overlaps(e)) out.push(toOccurrence(e, at, viewer));
  }
  return out.sort((a, b) => sortKey(a, viewer).localeCompare(sortKey(b, viewer)) || a.title.localeCompare(b.title));
}

/** All-day events come first on their day. */
const sortKey = (o: Occurrence, viewer: string) => (o.allDay ? `${o.start}T00:00:00!` : `${wallTimeAt(Date.parse(o.start), viewer)}~`);

// ------------------------------------------------------------------ changes

/** What an edit changes. Times change together: a new start without an end keeps the event's length. */
export interface EventChange {
  title?: string;
  location?: string | null;
  description?: string | null;
  status?: "confirmed" | "tentative";
  colorId?: string | null;
  timing?: EventTiming;
  /** A series' new recurrence lines, or null to stop it repeating. */
  recurrence?: string[] | null;
}

/** Which occurrences of a series an edit or a delete is for, as Google asks. */
export type Scope = "this" | "following" | "all";

/** What an edit does to a source's records: each written in full, or deleted. */
export type RecordOp = { op: "put"; event: CalendarEvent; created: boolean } | { op: "delete"; event: CalendarEvent };

/** An event with a change applied (its times, fields, and repeat), ready to write. */
function applied(e: CalendarEvent, change: EventChange): CalendarEvent {
  const fields: EventFields = { id: e.id, calendar: e.calendar, title: change.title ?? e.title, status: change.status ?? e.status };
  for (const key of ["location", "description", "colorId", "link"] as const) {
    const v = key === "link" ? e.link : change[key] === undefined ? e[key] : change[key];
    if (v) fields[key] = v;
  }
  const timing = change.timing ?? timingOf(e);
  if (e.series !== undefined) return { ...fields, ...timing, series: e.series, originalStart: e.originalStart };
  const recurrence = change.recurrence === undefined ? e.recurrence : change.recurrence;
  return recurrence?.length ? { ...fields, ...timing, recurrence } : { ...fields, ...timing };
}

/** Shift a timing by the move from one start to another, keeping its length and zone. */
function moved(t: EventTiming, from: EventTiming, to: EventTiming): EventTiming {
  if (t.allDay !== from.allDay || from.allDay !== to.allDay) {
    // An occurrence turned all-day (or back) turns its whole series, on the series' own days.
    const day = t.start.slice(0, 10);
    if (to.allDay) return { allDay: true, start: day, end: addDays(day, Math.max(1, dayDiff(to.start, to.end))) };
    const length = naiveMs(to.end) - naiveMs(to.start);
    const start = `${day}${to.start.slice(10)}`;
    return { allDay: false, start, end: wallPlus(start, length), ...(to.timeZone ? { timeZone: to.timeZone } : {}) };
  }
  if (t.allDay && from.allDay && to.allDay) {
    const shift = dayDiff(from.start, to.start);
    return { allDay: true, start: addDays(t.start, shift), end: addDays(t.start, shift + dayDiff(to.start, to.end)) };
  }
  if (!t.allDay && !from.allDay && !to.allDay) {
    const shift = naiveMs(to.start) - naiveMs(from.start);
    const start = wallPlus(t.start, shift);
    return { allDay: false, start, end: wallPlus(start, naiveMs(to.end) - naiveMs(to.start)), ...(to.timeZone ?? t.timeZone ? { timeZone: to.timeZone ?? t.timeZone } : {}) };
  }
  return t;
}

const timingOf = (e: CalendarEvent): EventTiming => (e.allDay ? { allDay: true, start: e.start, end: e.end } : { allDay: false, start: e.start, end: e.end, ...(e.timeZone ? { timeZone: e.timeZone } : {}) });

/** What an edit's target is: an event as stored, or an occurrence of a series worked out from it. */
export type Target =
  | { kind: "event"; event: CalendarEvent; series?: CalendarEvent }
  | { kind: "occurrence"; series: CalendarEvent & { recurrence: string[] }; occurrence: CalendarEvent & { series: string; originalStart: string } };

/**
 * What an address names among a calendar's events: a stored event (perhaps a changed occurrence,
 * with its series), or an occurrence of a series that hasn't been changed yet. Null if nothing.
 */
export function findTarget(events: readonly CalendarEvent[], id: string, viewer = "UTC"): Target | null {
  const byId = new Map(events.map((e) => [e.id, e]));
  const stored = byId.get(id);
  if (stored) return { kind: "event", event: stored, ...(stored.series !== undefined && byId.get(stored.series) ? { series: byId.get(stored.series) } : {}) };
  const parts = splitOccurrenceId(id);
  const series = parts && byId.get(parts.series);
  if (!parts || !series?.recurrence) return null;
  const zone = series.allDay ? undefined : series.timeZone;
  const start = startOfBasic(parts.basic, zone, viewer);
  const found = seriesStarts(series as CalendarEvent & { recurrence: string[] }, start.slice(0, 10), viewer).find((s) => s.basic === parts.basic);
  if (!found) return null;
  const s = series as CalendarEvent & { recurrence: string[] };
  const timing: EventTiming = s.allDay
    ? { allDay: true, start: found.start, end: addDays(found.start, dayDiff(s.start, s.end)) }
    : { allDay: false, start: found.start, end: wallPlus(found.start, naiveMs(s.end) - naiveMs(s.start)), ...(s.timeZone ? { timeZone: s.timeZone } : {}) };
  const { recurrence: _, ...fields } = s;
  return { kind: "occurrence", series: s, occurrence: { ...fields, ...timing, id, series: s.id, originalStart: found.start } as CalendarEvent & { series: string; originalStart: string } };
}

/** A series' events that are changed occurrences of it. */
const exceptionsOf = (events: readonly CalendarEvent[], series: string) => events.filter((e) => e.series === series);

/** The series cut to end just before an occurrence: COUNT shortened, or UNTIL set to just before it. */
function endBefore(series: CalendarEvent & { recurrence: string[] }, start: Day | WallTime, viewer: string): { cut: string[]; left: number | null } {
  const timed = !series.allDay;
  const zone = timed ? series.timeZone : undefined;
  const before = seriesStarts(series, start.slice(0, 10), viewer).filter((s) => s.start < start).length;
  const cut = series.recurrence.map((line) => {
    if (!/^RRULE:/i.test(line)) return line;
    const parts = line.slice(6).split(";").filter((p) => !/^(UNTIL|COUNT)=/i.test(p));
    const count = /;COUNT=(\d+)/i.exec(`;${line.slice(6)}`)?.[1];
    if (count) return `RRULE:${[...parts, `COUNT=${before}`].join(";")}`;
    const until = !timed ? compact(addDays(start, -1)) : zone ? zForm(instantOf(start, zone) - 1000) : compact(wallPlus(start, -1000));
    return `RRULE:${[...parts, `UNTIL=${until}`].join(";")}`;
  });
  const count = series.recurrence.map((l) => /;COUNT=(\d+)/i.exec(`;${l.replace(/^RRULE:/i, "")}`)?.[1]).find(Boolean);
  return { cut, left: count ? Number(count) - before : null };
}

/** The recurrence lines for the rest of a series split off at an occurrence. */
function restOf(series: CalendarEvent & { recurrence: string[] }, left: number | null): string[] {
  return series.recurrence
    .filter((l) => /^RRULE:/i.test(l))
    .map((l) => (left === null ? l : `RRULE:${[...l.slice(6).split(";").filter((p) => !/^COUNT=/i.test(p)), `COUNT=${left}`].join(";")}`));
}

/**
 * The records an edit writes. `scope` matters only for a series' occurrences: "this" changes that
 * one alone, "following" splits the series there and changes the new part, "all" changes the series
 * (moving every occurrence by as much as this one moved). `newId` makes ids for new records.
 */
export function planUpdate(events: readonly CalendarEvent[], target: Target, change: EventChange, scope: Scope, newId: () => string, viewer = "UTC"): RecordOp[] {
  if (target.kind === "event" && target.event.series === undefined) {
    if (scope !== "this" && target.event.recurrence && change.timing) {
      // A series edited from itself: its first occurrence moved, so the series moves with it.
      return [{ op: "put", event: applied(target.event, { ...change, timing: moved(timingOf(target.event), timingOf(target.event), change.timing) }), created: false }];
    }
    return [{ op: "put", event: applied(target.event, change), created: false }];
  }
  const series = (target.kind === "occurrence" ? target.series : target.series) as (CalendarEvent & { recurrence: string[] }) | undefined;
  const occurrence = target.kind === "occurrence" ? target.occurrence : (target.event as CalendarEvent & { series: string; originalStart: string });
  if (scope === "this" || !series) return [{ op: "put", event: applied(occurrence, { ...change, recurrence: undefined }), created: target.kind === "occurrence" }];
  const timing = change.timing ? moved(timingOf(series), timingOf(occurrence), change.timing) : undefined;
  const isFirst = occurrence.originalStart === series.start;
  if (scope === "all" || isFirst) {
    const ops: RecordOp[] = [{ op: "put", event: applied(series, { ...change, timing }), created: false }];
    // Changed times reset occurrences changed on their own, as Google does; other fields leave them be.
    if (timing) for (const e of exceptionsOf(events, series.id)) ops.push({ op: "delete", event: e });
    return ops;
  }
  const { cut, left } = endBefore(series, occurrence.originalStart, viewer);
  const startAt = change.timing ?? timingOf(occurrence);
  const rest = applied({ ...series, id: newId(), ...startAt, recurrence: restOf(series, left) } as CalendarEvent, { ...change, timing: undefined, recurrence: change.recurrence });
  const ops: RecordOp[] = [
    { op: "put", event: { ...series, recurrence: cut }, created: false },
    { op: "put", event: rest, created: true },
  ];
  for (const e of exceptionsOf(events, series.id)) if (e.series !== undefined && e.originalStart >= occurrence.originalStart) ops.push({ op: "delete", event: e });
  return ops;
}

/** The records a delete writes: "this" cancels one occurrence, "following" ends the series before it, "all" deletes the series. */
export function planDelete(events: readonly CalendarEvent[], target: Target, scope: Scope, viewer = "UTC"): RecordOp[] {
  if (target.kind === "event" && target.event.series === undefined) {
    return [{ op: "delete", event: target.event }, ...(target.event.recurrence ? exceptionsOf(events, target.event.id).map((e) => ({ op: "delete" as const, event: e })) : [])];
  }
  const series = (target.kind === "occurrence" ? target.series : target.series) as (CalendarEvent & { recurrence: string[] }) | undefined;
  const occurrence = target.kind === "occurrence" ? target.occurrence : (target.event as CalendarEvent & { series: string; originalStart: string });
  if (scope === "this" || !series) return [{ op: "put", event: { ...occurrence, status: "cancelled" }, created: target.kind === "occurrence" }];
  if (scope === "all" || occurrence.originalStart === series.start) return planDelete(events, { kind: "event", event: series }, "all", viewer);
  const { cut } = endBefore(series, occurrence.originalStart, viewer);
  return [
    { op: "put", event: { ...series, recurrence: cut }, created: false },
    ...exceptionsOf(events, series.id)
      .filter((e) => e.series !== undefined && e.originalStart >= occurrence.originalStart)
      .map((e) => ({ op: "delete" as const, event: e })),
  ];
}

/** A new id as Google accepts one from us: 26 characters from 0-9 and a-v. */
export function newEventId(random: () => number = Math.random): string {
  const digits = "0123456789abcdefghijklmnopqrstuv";
  return Array.from({ length: 26 }, () => digits[Math.floor(random() * 32)]).join("");
}
