// Records: what data sources bring into a workspace (ADR 0007), kept apart from notes. Each record is
// a JSON file under .common-ink/records/, so it has history, diffs, undo and an author like any file,
// and opens read-only; it changes only through its data source. The records table is an index of
// those files, made from their text as they're written, so calendars can ask for a range of days.
import { parseEvent, type CalendarEvent } from "./calendar.ts";
import type { Db, FilePath } from "./files.ts";

export const RECORDS_DIR = ".common-ink/records/";

/** Where records come from: Google, or the Sample calendar that Previews and local development have instead. */
export type SourceId = "google" | "sample";
export const SOURCE_IDS: readonly SourceId[] = ["google", "sample"];

/** What a record is. Contacts come later, the same way. */
export type RecordKind = "event" | "calendar";

/** A record's place: its source, its kind, the collection it's in (an event's calendar) and its id there. */
export interface RecordKey {
  source: SourceId;
  kind: RecordKind;
  /** An event's calendar; "" for a calendar itself. */
  collection: string;
  id: string;
}

const FOLDER: Record<RecordKind, string> = { event: "events", calendar: "calendars" };
const KIND_OF_FOLDER: Record<string, RecordKind> = { events: "event", calendars: "calendar" };

/** Path segments are written so any id is one segment: "/" and "%" (and nothing else) are escaped. */
const seg = (s: string) => s.replace(/%/g, "%25").replace(/\//g, "%2F");
const unseg = (s: string) => s.replace(/%2F/gi, "/").replace(/%25/g, "%");

/** A record's file: .common-ink/records/sample/events/work/standup.json. */
export function recordPath(key: RecordKey): FilePath {
  const where = key.kind === "calendar" ? seg(key.id) : `${seg(key.collection)}/${seg(key.id)}`;
  return `${RECORDS_DIR}${key.source}/${FOLDER[key.kind]}/${where}.json` as FilePath;
}

export const isRecordPath = (path: string) => path.startsWith(RECORDS_DIR);

/** The record a file is, or null if it isn't one. */
export function keyOfPath(path: string): RecordKey | null {
  if (!isRecordPath(path) || !path.endsWith(".json")) return null;
  const parts = path.slice(RECORDS_DIR.length, -".json".length).split("/");
  const source = parts[0] as SourceId;
  const kind = KIND_OF_FOLDER[parts[1]];
  if (!SOURCE_IDS.includes(source) || !kind) return null;
  if (kind === "calendar" && parts.length === 3) return { source, kind, collection: "", id: unseg(parts[2]) };
  if (kind === "event" && parts.length === 4) return { source, kind, collection: unseg(parts[2]), id: unseg(parts[3]) };
  return null;
}

/**
 * How a note links to a record: `event:sample/work/standup_20261005T090000Z`, the way it's written in
 * `[Standup](event:sample/work/standup_20261005T090000Z)`. A calendar or id with characters a link
 * can't hold is percent-encoded.
 */
export function addressOf(key: Pick<RecordKey, "source" | "collection" | "id">): string {
  return `event:${key.source}/${encodeURIComponent(key.collection)}/${encodeURIComponent(key.id)}`;
}

/** The event an address names, or null if it isn't one. */
export function parseAddress(address: string): RecordKey | null {
  const m = /^event:([a-z]+)\/([^/\s]+)\/([^/\s]+)$/.exec(address.trim());
  if (!m || !SOURCE_IDS.includes(m[1] as SourceId)) return null;
  try {
    return { source: m[1] as SourceId, kind: "event", collection: decodeURIComponent(m[2]), id: decodeURIComponent(m[3]) };
  } catch {
    return null;
  }
}

/** Day spans are kept as instants read as UTC, so a query widens by this much for floating times and other zones. */
const SLACK = 14 * 3_600_000;
const asUtc = (v: string) => Date.parse(v.length === 10 ? `${v}T00:00:00Z` : `${v.slice(0, 19)}Z`);

interface Row {
  path: string;
  source: string;
  kind: string;
  collection: string;
  id: string;
  starts: number | null;
  ends: number | null;
  repeats: number;
  series: string | null;
}

/**
 * The records index, on the workspace's database. `observe` is told of every file written (in the
 * same transaction), so the index never disagrees with the files. Rebuilding it from the files
 * gives the same index.
 */
export class Records {
  constructor(private db: Db) {
    db.run(
      `CREATE TABLE IF NOT EXISTS records(path TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, collection TEXT NOT NULL,
        id TEXT NOT NULL, starts INTEGER, ends INTEGER, repeats INTEGER NOT NULL DEFAULT 0, series TEXT)`,
    );
    db.run("CREATE INDEX IF NOT EXISTS records_by_time ON records(source, kind, starts)");
    db.run("CREATE INDEX IF NOT EXISTS records_by_series ON records(source, collection, series)");
  }

  /** A file was written (text) or deleted (null): keep its row, if it's a record. */
  observe(path: string, text: string | null): void {
    const key = keyOfPath(path);
    if (!key) return;
    this.db.run("DELETE FROM records WHERE path = ?", path);
    if (text === null) return;
    let starts: number | null = null;
    let ends: number | null = null;
    let repeats = 0;
    let series: string | null = null;
    if (key.kind === "event") {
      const e = readEvent(text);
      if (!e) return;
      starts = asUtc(e.start);
      ends = e.recurrence ? null : asUtc(e.end);
      repeats = e.recurrence ? 1 : 0;
      series = e.series ?? null;
    }
    this.db.run(
      "INSERT INTO records(path, source, kind, collection, id, starts, ends, repeats, series) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      path, key.source, key.kind, key.collection, key.id, starts, ends, repeats, series,
    );
  }

  /** The paths of a source's events that may happen between two instants: overlapping ones, every series that has begun, and changed occurrences. */
  eventsBetween(source: SourceId, from: number, to: number, calendars?: readonly string[]): FilePath[] {
    const rows = this.db.all<Row>(
      `SELECT path, collection FROM records WHERE source = ? AND kind = 'event' AND starts < ?
        AND (repeats = 1 OR series IS NOT NULL OR ends > ? OR ends = starts)`,
      source, to + SLACK, from - SLACK,
    );
    return rows.filter((r) => !calendars || calendars.includes(r.collection)).map((r) => r.path as FilePath);
  }

  /** The paths an edit of one event needs: it, its series, and the series' changed occurrences. */
  family(source: SourceId, calendar: string, ids: readonly string[]): FilePath[] {
    const out = new Set<string>();
    for (const id of ids) {
      for (const r of this.db.all<Row>("SELECT path FROM records WHERE source = ? AND kind = 'event' AND collection = ? AND (id = ? OR series = ?)", source, calendar, id, id)) out.add(r.path);
    }
    return [...out] as FilePath[];
  }

  /** A calendar's events, as paths. */
  inCalendar(source: SourceId, calendar: string): FilePath[] {
    return this.db.all<Row>("SELECT path FROM records WHERE source = ? AND kind = 'event' AND collection = ?", source, calendar).map((r) => r.path as FilePath);
  }

  /** A source's records of a kind, as paths. */
  all(source: SourceId, kind: RecordKind): FilePath[] {
    return this.db.all<Row>("SELECT path FROM records WHERE source = ? AND kind = ? ORDER BY path", source, kind).map((r) => r.path as FilePath);
  }

  /** How many records each source has, by kind. */
  counts(): Array<{ source: SourceId; kind: RecordKind; count: number }> {
    return this.db.all<{ source: SourceId; kind: RecordKind; count: number }>("SELECT source, kind, count(*) AS count FROM records GROUP BY source, kind ORDER BY source, kind");
  }

  /**
   * Make the index again from the files, as it would be if every record had just been written. All of
   * it or none: a workspace that stopped partway would find an index and never finish it.
   */
  rebuild(files: Iterable<{ path: string; text: string }>): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM records");
      for (const f of files) this.observe(f.path, f.text);
    });
  }
}

/** A record file's event, or null if its text isn't one. */
export function readEvent(text: string): CalendarEvent | null {
  try {
    const e = parseEvent(JSON.parse(text));
    return typeof e === "string" ? null : e;
  } catch {
    return null;
  }
}

const ORDER = ["id", "calendar", "title", "status", "allDay", "start", "end", "timeZone", "recurrence", "series", "originalStart", "location", "description", "colorId", "link", "color", "primary", "writable", "selected"];
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

/** A record as its file's text: indented JSON, keys in one order, so a diff shows only what changed. */
export function recordText(record: object): string {
  const ordered = Object.fromEntries(Object.entries(record).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
