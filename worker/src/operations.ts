// What people and agents can do with a workspace, defined once. The HTTP API (and so the web app and
// the CLI) and the MCP server both run these, so an agent can do anything the UI does, the same way.
import { timingFrom, type EditResult, type EventEdit, type LinkingNote, type Refused, type SourceState, type SourceStatus } from "./data-sources.ts";
import { isTimeZone, type Calendar, type CalendarEvent, type EventChange, type EventTiming, type Occurrence, type Scope } from "./calendar.ts";
import { isRecordPath, parseAddress } from "./records.ts";
import { parseRule, toRRule } from "./recurrence.ts";
import type { TaskArgs, Ticked } from "./complete-task.ts";
import { listEmbeds } from "./embed-list.ts";
import { DEFAULT_SETTINGS, defaultsText, isReadOnly } from "./settings.ts";
import type { Contact } from "./sources.ts";
import { LABELS_PATH, labelsText, parseLabels } from "./labels.ts";
import { parseUploads, UPLOADS_PATH, uploadUrl, type UploadResult } from "./uploads.ts";
import { parseFilePath, type Author, type FileDiff, type FilePath, type Change, type WorkspaceFile, type FileSummary, type HistoryQuery, type Revision, type UndoResult, type Write, type WriteResult } from "./files.ts";

/** The workspace, as the Durable Object's stub offers it. */
export interface Store {
  list(): Promise<FileSummary[]> | FileSummary[];
  read(path: WorkspaceFile["path"]): Promise<WorkspaceFile | null> | WorkspaceFile | null;
  write(w: Write): Promise<WriteResult> | WriteResult;
  recent(q: HistoryQuery): Promise<Change[]> | Change[];
  undo(revisions: Revision[], author: Author): Promise<UndoResult[]> | UndoResult[];
  sourceStatus(email: string): Promise<SourceStatus> | SourceStatus;
  calendars(): Promise<Calendar[]> | Calendar[];
  events(from: number, to: number, zone: string, calendars?: string[]): Promise<Occurrence[]> | Occurrence[];
  event(address: string, zone?: string): Promise<EventFound | null> | EventFound | null;
  editEvent(edit: EventEdit, author: Author, zone?: string): Promise<EditResult | Refused>;
  syncSources(force?: boolean): Promise<SourceState | undefined>;
  contacts(email: string, query: string): Promise<Contact[]>;
  combined(revisions: Revision[]): Promise<FileDiff[]> | FileDiff[];
  versionAt(path: FilePath, revision: Revision): Promise<string | null> | string | null;
  restore(path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author): Promise<WriteResult | null> | WriteResult | null;
  upload(name: string, data: ArrayBuffer, author: Author): Promise<UploadResult>;
  completeTask(args: TaskArgs, author: Author): Promise<Ticked> | Ticked;
}

/** An event as read_event finds it: as stored, or worked out from its series, with the series. */
export interface EventFound {
  address: string;
  event: CalendarEvent;
  series?: CalendarEvent;
  /** Its record file, which has its history; null for an occurrence nobody has changed. */
  path: FilePath | null;
  /** The notes that link to it, or to its series. */
  notes: LinkingNote[];
}

/** The person whose data sources an author reads: themselves, or whoever an agent works for. */
function personOf(author: Author): string {
  const email = author.kind === "user" ? author.email : author.kind === "sync" ? undefined : author.by;
  if (!email) throw new Error("Data sources belong to a person, and this agent isn't working for one");
  return email;
}

const isoTime = (v: unknown, fallback: Date): string | null => {
  if (v === undefined || v === "") return fallback.toISOString();
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Files are larger than this only by mistake, and a Durable Object's SQLite rows top out at 2 MB. */
const MAX_FILE_BYTES = 1_000_000;

type Args = Record<string, unknown>;
/** `internal`: the operation failed in a way the caller can't fix, which is logged; `error` says so in a sentence. */
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; internal?: true };

export interface Operation<T = unknown> {
  description: string;
  /** JSON Schema for the arguments, as MCP lists it. */
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  parse(args: Args): Parsed<T>;
  run(store: Store, args: T, author: Author): Promise<unknown>;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

/** A whole number from JSON or a query string. */
function count(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : undefined;
}

const PATH = { type: "string", description: 'A file\'s path, like "Projects/Plan.md" or ".common-ink/layout.json"' };
const ADDRESS = { type: "string", description: "An event's address, like event:google/primary/abc123, from list_events" };
const ZONE = { type: "string", description: "An IANA time zone, like America/New_York" };
const TIME = { type: "string", description: "A wall time like 2026-10-05T09:00, or a day like 2026-10-05 for all day" };
const SCOPE = { type: "string", enum: ["this", "following", "all"], description: "For an occurrence of a repeating event: this one, this and following, or all of them" };
const RECURRENCE = { type: ["string", "array", "null"], items: { type: "string" }, description: "weekly, 2w, mon,thu, 1st-tue, last-fri… or RRULE lines" };

const zoneOf = (v: unknown): string | null => (v === undefined || v === "" ? "UTC" : typeof v === "string" && isTimeZone(v) ? v : null);
const scopeOf = (v: unknown): Scope | undefined | null => (v === undefined || v === "" ? undefined : v === "this" || v === "following" || v === "all" ? v : null);

/** A repeat as tasks write it (`weekly`, `1st-tue`) or as RRULE lines, as recurrence lines; [] for none. */
function recurrenceFrom(v: unknown): string[] | string | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return [];
  const items = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return '"recurrence" is a rule like weekly, or RRULE lines';
    const rule = /^(EXDATE|RDATE)[:;]/i.test(item) ? null : parseRule(item);
    if (/^(EXDATE|RDATE)[:;]/i.test(item)) out.push(item);
    else if (rule && rule.from === "due") out.push(/^RRULE:/i.test(item) ? item : toRRule(rule));
    else return `"${item}" isn't a repeat: try weekly, 2w, mon,thu, 1st-tue, last-fri or RRULE:FREQ=…`;
  }
  return out;
}

/** An event's times from an agent's start and end: a missing end is 30 minutes, or one day, after the start. */
function timingWithEnd(a: Args): EventTiming | string {
  if (typeof a.start !== "string") return '"start" is a wall time like 2026-10-05T09:00, or a day like 2026-10-05';
  const allDay = a.allDay === true || (a.allDay !== false && /^\d{4}-\d{2}-\d{2}$/.test(a.start));
  const end = typeof a.end === "string" && a.end ? a.end : allDay ? nextDay(a.start.slice(0, 10)) : plusMinutes(a.start, 30);
  return timingFrom({ ...a, allDay, end });
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const plusMinutes = (wall: string, minutes: number) => new Date(Date.parse(`${wall.slice(0, 16)}:00Z`) + minutes * 60_000).toISOString().slice(0, 19);

/** An edit's change from an agent's fields, over the event as it is: new times keep its length and zone unless they say otherwise. */
function changeFrom(a: Args, current: CalendarEvent): EventChange | string {
  const change: EventChange = {};
  if (typeof a.title === "string") change.title = a.title;
  for (const key of ["location", "description"] as const) if (a[key] === null || typeof a[key] === "string") change[key] = a[key] as string | null;
  if (a.start !== undefined || a.end !== undefined || a.allDay !== undefined || a.timeZone !== undefined) {
    const allDay = typeof a.allDay === "boolean" ? a.allDay : typeof a.start === "string" ? /^\d{4}-\d{2}-\d{2}$/.test(a.start) : current.allDay;
    const start = typeof a.start === "string" ? a.start : allDay === current.allDay ? current.start : current.start.slice(0, 10) + (allDay ? "" : "T09:00");
    const length = current.allDay === allDay ? (allDay ? Date.parse(`${current.end}T00:00:00Z`) - Date.parse(`${current.start}T00:00:00Z`) : Date.parse(`${current.end}Z`) - Date.parse(`${current.start}Z`)) : allDay ? 86_400_000 : 1_800_000;
    const end = typeof a.end === "string" ? a.end : allDay ? new Date(Date.parse(`${start.slice(0, 10)}T00:00:00Z`) + length).toISOString().slice(0, 10) : new Date(Date.parse(`${start.slice(0, 16)}:00Z`) + length).toISOString().slice(0, 19);
    const timeZone = a.timeZone === undefined ? (current.allDay ? undefined : current.timeZone) : a.timeZone || undefined;
    const timing = timingFrom({ allDay, start, end, ...(timeZone ? { timeZone } : {}) });
    if (typeof timing === "string") return timing;
    change.timing = timing;
  }
  if (a.recurrence !== undefined) {
    const recurrence = recurrenceFrom(a.recurrence);
    if (typeof recurrence === "string") return recurrence;
    change.recurrence = recurrence?.length ? recurrence : null;
  }
  return change;
}

/** Run an edit; one that can't be made comes back as an error that says why. */
async function editing(run: () => Promise<EditResult | Refused>): Promise<EditResult> {
  const result = await run();
  if (result.status === "refused") throw new OperationError(result.error);
  return result;
}

function op<T>(o: Operation<T>): Operation<T> {
  return o;
}

export const OPERATIONS = {
  list_files: op<Record<string, never>>({
    description: "List every file in the workspace (notes and workspace JSON) with its revision.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store) => store.list(),
  }),
  read_file: op<{ path: WorkspaceFile["path"] }>({
    description: "Read a file's text and revision. Pass the revision back as `base` when you write it.",
    input: { type: "object", properties: { path: PATH }, required: ["path"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      return path ? ok({ path }) : fail('"path" must be a path ending in .md or .json');
    },
    run: async (store, { path }) => (path === DEFAULT_SETTINGS ? { path, text: defaultsText(), revision: 0 } : store.read(path)),
  }),
  write_file: op<Omit<Write, "author">>({
    description:
      "Write a file's whole text, given the revision you read (`base`, or 0 for a new file). If it changed since, your edit is merged in; if it can't be, nothing is saved and you get the current file back.",
    input: {
      type: "object",
      properties: { path: PATH, text: { type: "string" }, base: { type: "integer", minimum: 0 } },
      required: ["path", "text", "base"],
    },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const base = count(a.base);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (isRecordPath(path)) return fail(`${path} is a data source's record: change it with update_event`);
      if (isReadOnly(path)) return fail(`${path} is written by Common Ink and can't be changed`);
      if (typeof a.text !== "string" || new TextEncoder().encode(a.text).length > MAX_FILE_BYTES) return fail('"text" must be a string under 1 MB');
      if (base === undefined) return fail('"base" must be the revision you started from, or 0 for a new file');
      return ok({ path, text: a.text, base });
    },
    run: async (store, w, author) => store.write({ ...w, author }),
  }),
  delete_file: op<{ path: FilePath; base: Revision }>({
    description:
      "Delete a file, given the revision you read (`base`). It's a change like any other: it shows in history, and undoing it brings the file back. If the file changed since you read it, nothing is deleted.",
    input: { type: "object", properties: { path: PATH, base: { type: "integer", minimum: 1 } }, required: ["path", "base"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const base = count(a.base);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (isRecordPath(path)) return fail(`${path} is a data source's record: delete it with delete_event`);
      if (isReadOnly(path)) return fail(`${path} is written by Common Ink and can't be changed`);
      if (!base) return fail('"base" must be the revision you read');
      return ok({ path, base });
    },
    run: async (store, { path, base }, author) => store.write({ path, text: "", base, author, delete: true }),
  }),
  history: op<HistoryQuery>({
    description: "Changes across the workspace, newest first, each with its author, time and line diff. Filter by file or by author.",
    input: {
      type: "object",
      properties: {
        path: PATH,
        author: { type: "string", description: 'An author key from a change\'s "author", like "agent:Claude:ada@example.com" or "user:ada@example.com"' },
        before: { type: "integer", description: "Only changes older than this revision, for paging" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    parse: (a) => {
      const q: HistoryQuery = {};
      if (a.path !== undefined && a.path !== "") {
        const path = parseFilePath(a.path);
        if (!path) return fail('"path" must be a path ending in .md or .json');
        q.path = path;
      }
      if (typeof a.author === "string" && a.author) q.author = a.author;
      q.before = count(a.before);
      q.limit = count(a.limit);
      return ok(q);
    },
    run: async (store, q) => store.recent(q),
  }),
  undo: op<{ revisions: Revision[] }>({
    description:
      "Undo changes by revision, newest first, each recorded as a new change by you. Later edits elsewhere in the file are kept; an undo that clashes with them does nothing. Undoing an undo redoes it.",
    input: { type: "object", properties: { revisions: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["revisions"] },
    parse: (a) => {
      const revisions = Array.isArray(a.revisions) ? a.revisions.map(count) : [];
      return revisions.length && revisions.every((r) => r !== undefined && r > 0) ? ok({ revisions: revisions as number[] }) : fail('"revisions" must be a list of change revisions');
    },
    run: async (store, { revisions }, author) => store.undo(revisions, author),
  }),
  data_sources: op<Record<string, never>>({
    description: "Which data sources you have: your Google calendar and contacts, sample data, or none yet.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store, _args, author) => store.sourceStatus(personOf(author)),
  }),
  sync_calendar: op<{ force: boolean }>({
    description:
      "Bring the calendar's own changes in now (Google's), after sending edits waiting for it, unless it synced in the last 30 seconds (`force` syncs anyway). It also syncs on its own every 10 minutes. Says how the source stands: its state, last sync, errors, and edits still waiting.",
    input: { type: "object", properties: { force: { type: "boolean" } } },
    parse: (a) => ok({ force: a.force === true || a.force === "true" }),
    run: async (store, { force }) => store.syncSources(force),
  }),
  list_calendars: op<Record<string, never>>({
    description: "Your calendars: each one's id (what events name as their calendar), title, colour, whether it's your primary one, and whether events can be added and changed in it.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store) => store.calendars(),
  }),
  list_events: op<{ from: number; to: number; zone: string; calendars?: string[] }>({
    description:
      "Every time events happen between two times (ISO 8601; by default the next 14 days), oldest first, seen from a time zone (IANA, default UTC). A repeating event comes once per occurrence. Each has an `address` (event:<source>/<calendar>/<id>) to read, change, delete or link it by; an occurrence of a series has its own address and the series' id in `series`.",
    input: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        zone: ZONE,
        calendars: { type: "array", items: { type: "string" }, description: "Only these calendars' ids" },
      },
    },
    parse: (a) => {
      const now = new Date();
      const from = isoTime(a.from, now);
      const to = isoTime(a.to, new Date(Date.parse(from ?? now.toISOString()) + 14 * 86_400_000));
      if (!from || !to) return fail('"from" and "to" must be times, like "2026-10-05T00:00:00Z"');
      const zone = zoneOf(a.zone);
      if (!zone) return fail(`"${String(a.zone)}" isn't a time zone, like America/New_York`);
      if (to <= from) return fail('"to" must be after "from"');
      const calendars = typeof a.calendars === "string" ? a.calendars.split(",").filter(Boolean) : Array.isArray(a.calendars) ? a.calendars.map(String) : undefined;
      return ok({ from: Date.parse(from), to: Date.parse(to), zone, ...(calendars ? { calendars } : {}) });
    },
    run: async (store, { from, to, zone, calendars }) => store.events(from, to, zone, calendars),
  }),
  read_event: op<{ address: string; zone: string }>({
    description:
      "One event by its address: as stored, or, for an occurrence of a series nobody has changed, worked out from the series (which comes too). `path` is its record file, whose history (the history tool) shows every change to it, by whom. `notes` are the notes that link to it, `[Title](event:…)`, or to its series (`series: true`).",
    input: { type: "object", properties: { address: ADDRESS, zone: ZONE }, required: ["address"] },
    parse: (a) => {
      const zone = zoneOf(a.zone);
      if (typeof a.address !== "string" || !parseAddress(a.address)) return fail('"address" is an event\'s address, like event:google/primary/abc123');
      return zone ? ok({ address: a.address, zone }) : fail('"zone" is a time zone, like America/New_York');
    },
    run: async (store, { address, zone }) => store.event(address, zone),
  }),
  create_event: op<{ edit: EventEdit; zone: string }>({
    description:
      "Add an event. `start` and `end` are wall times (2026-10-05T09:00) in `timeZone` (IANA; leave it out for one that floats with the viewer), or days (2026-10-05) for an all-day event, whose `end` is the day after its last. Without `end` it lasts 30 minutes, or one day. `recurrence` repeats it: a rule as tasks write it (weekly, 2w, mon,thu, 1st-tue, last-fri) or RRULE lines. It goes in your primary calendar unless `calendar` names another. The change is yours.",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "Its id, for sending the same create again safely: 5 to 1024 of 0-9 and a-v. Left out, it gets a new one." },
        title: { type: "string" },
        start: TIME,
        end: TIME,
        allDay: { type: "boolean" },
        timeZone: ZONE,
        calendar: { type: "string" },
        location: { type: "string" },
        description: { type: "string" },
        recurrence: RECURRENCE,
        zone: ZONE,
      },
      required: ["title", "start"],
    },
    parse: (a) => {
      if (typeof a.title !== "string" || !a.title.trim()) return fail('"title" is the event\'s name');
      if (a.id !== undefined && (typeof a.id !== "string" || !/^[0-9a-v]{5,1024}$/.test(a.id))) return fail('"id" is 5 to 1024 of 0-9 and a-v, or left out for a new one');
      const timing = timingWithEnd(a);
      if (typeof timing === "string") return fail(timing);
      const recurrence = recurrenceFrom(a.recurrence);
      if (typeof recurrence === "string") return fail(recurrence);
      const zone = zoneOf(a.zone);
      if (!zone) return fail('"zone" is a time zone, like America/New_York');
      return ok({
        zone,
        edit: {
          op: "create",
          ...(typeof a.id === "string" ? { id: a.id } : {}),
          title: a.title.trim(),
          timing,
          ...(typeof a.calendar === "string" && a.calendar ? { calendar: a.calendar } : {}),
          ...(typeof a.location === "string" && a.location ? { location: a.location } : {}),
          ...(typeof a.description === "string" && a.description ? { description: a.description } : {}),
          ...(recurrence?.length ? { recurrence } : {}),
        },
      });
    },
    run: async (store, { edit, zone }, author) => editing(() => store.editEvent(edit, author, zone)),
  }),
  update_event: op<{ address: string; scope?: Scope; fields: Args; zone: string }>({
    description:
      "Change an event by its address: any of `title`, `start`, `end`, `allDay`, `timeZone`, `location`, `description` (null or \"\" clears one), and for a series, `recurrence` (null stops it repeating). A new `start` alone keeps its length. For an occurrence of a repeating event, `scope` says which: \"this\" one (the default), \"following\" (splits the series there), or \"all\" (moves every occurrence by as much as this one moved). The change is yours; undo takes it back.",
    input: {
      type: "object",
      properties: { address: ADDRESS, scope: SCOPE, title: { type: "string" }, start: TIME, end: TIME, allDay: { type: "boolean" }, timeZone: ZONE, location: { type: ["string", "null"] }, description: { type: ["string", "null"] }, recurrence: RECURRENCE, zone: ZONE },
      required: ["address"],
    },
    parse: (a) => {
      if (typeof a.address !== "string" || !parseAddress(a.address)) return fail('"address" is an event\'s address, like event:google/primary/abc123');
      const scope = scopeOf(a.scope);
      if (scope === null) return fail('"scope" is this, following or all');
      const zone = zoneOf(a.zone);
      if (!zone) return fail('"zone" is a time zone, like America/New_York');
      return ok({ address: a.address, ...(scope ? { scope } : {}), fields: a, zone });
    },
    run: async (store, { address, scope, fields, zone }, author) => {
      const found = await store.event(address, zone);
      if (!found) throw new OperationError(`There's no event at ${address}`);
      const change = changeFrom(fields, found.event);
      if (typeof change === "string") throw new OperationError(change);
      return editing(() => store.editEvent({ op: "update", address, change, scope: scope ?? (found.event.recurrence ? "all" : "this") }, author, zone));
    },
  }),
  delete_event: op<{ address: string; scope?: Scope; zone: string }>({
    description:
      "Delete an event by its address. For an occurrence of a repeating event, `scope` says which: \"this\" one (the default; it's cancelled), \"following\" (the series ends before it), or \"all\" (the whole series). The change is yours; undo brings it back.",
    input: { type: "object", properties: { address: ADDRESS, scope: SCOPE, zone: ZONE }, required: ["address"] },
    parse: (a) => {
      if (typeof a.address !== "string" || !parseAddress(a.address)) return fail('"address" is an event\'s address, like event:google/primary/abc123');
      const scope = scopeOf(a.scope);
      if (scope === null) return fail('"scope" is this, following or all');
      const zone = zoneOf(a.zone);
      return zone ? ok({ address: a.address, ...(scope ? { scope } : {}), zone }) : fail('"zone" is a time zone, like America/New_York');
    },
    run: async (store, { address, scope, zone }, author) => {
      const found = await store.event(address, zone);
      if (!found) throw new OperationError(`There's no event at ${address}`);
      return editing(() => store.editEvent({ op: "delete", address, scope: scope ?? (found.event.recurrence ? "all" : "this") }, author, zone));
    },
  }),
  link_event: op<{ address: string; path: FilePath }>({
    description:
      "Link a note to an event: adds a line with `[Title](event:…)` to the end of the note (making the note if it's missing). The app draws the link as the event's time and title, kept up to date, and the event lists the notes that link to it. Write the same link anywhere in a note yourself to link it there instead.",
    input: { type: "object", properties: { address: ADDRESS, path: PATH }, required: ["address", "path"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      if (!path || !path.endsWith(".md") || isRecordPath(path)) return fail('"path" is a note\'s path, ending in .md');
      if (typeof a.address !== "string" || !parseAddress(a.address)) return fail('"address" is an event\'s address, like event:google/primary/abc123');
      return ok({ address: a.address, path });
    },
    run: async (store, { address, path }, author) => {
      const found = await store.event(address);
      if (!found) throw new OperationError(`There's no event at ${address}`);
      const link = `[${found.event.title.replace(/[[\]]/g, "") || "Event"}](${address})`;
      for (let tries = 0; tries < 3; tries++) {
        const file = await store.read(path);
        const text = file?.text ?? `# ${found.event.title || "Meeting notes"}\n`;
        const result = await store.write({ path, text: `${text.replace(/\n*$/, "\n\n")}${link}\n`, base: file?.revision ?? 0, author });
        if (result.status !== "conflict") return { path, link, revision: result.file.revision };
      }
      throw new OperationError(`${path} kept changing; try again`);
    },
  }),
  list_contacts: op<{ query: string }>({
    description: "Your contacts, optionally only those whose name, email or organization contains `query`.",
    input: { type: "object", properties: { query: { type: "string" } } },
    parse: (a) => ok({ query: typeof a.query === "string" ? a.query : "" }),
    run: async (store, { query }, author) => store.contacts(personOf(author), query),
  }),
  diff: op<{ revisions: Revision[] }>({
    description:
      "What chosen changes did together, file by file: each run of changes next to each other in a file's history, as its text before and after. Changes not chosen are left out.",
    input: { type: "object", properties: { revisions: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["revisions"] },
    parse: (a) => {
      const revisions = Array.isArray(a.revisions) ? a.revisions.map(count) : [];
      return revisions.length && revisions.every((r) => r !== undefined && r > 0) ? ok({ revisions: revisions as number[] }) : fail('"revisions" must be a list of change revisions');
    },
    run: async (store, { revisions }) => store.combined(revisions),
  }),
  read_version: op<{ path: FilePath; revision: Revision }>({
    description: "A file's text as it was at one of its revisions (a change's revision, or a label's).",
    input: { type: "object", properties: { path: PATH, revision: { type: "integer", minimum: 1 } }, required: ["path", "revision"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const revision = count(a.revision);
      return path && revision ? ok({ path, revision }) : fail('"path" and "revision" must name one of the file\'s revisions');
    },
    run: async (store, { path, revision }) => {
      const text = await store.versionAt(path, revision);
      return text === null ? null : { path, revision, text };
    },
  }),
  restore: op<{ path: FilePath; at: { revision: Revision } | { before: Revision } }>({
    description:
      "Put a file back the way it was at one of its revisions (`revision`, such as a label's), or just before one of its changes (`before`), as a new change by you. The changes since stay in history, and this can be undone.",
    input: { type: "object", properties: { path: PATH, revision: { type: "integer", minimum: 0 }, before: { type: "integer", minimum: 1 } }, required: ["path"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const revision = count(a.revision);
      const before = count(a.before);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (revision !== undefined) return ok({ path, at: { revision } });
      return before ? ok({ path, at: { before } }) : fail('Say which version: "revision", or "before" a change');
    },
    run: async (store, { path, at }, author) => store.restore(path, at, author),
  }),
  labels: op<{ path?: FilePath }>({
    description: "Labels: names given to a note's state at one revision. All of them, or one file's.",
    input: { type: "object", properties: { path: PATH } },
    parse: (a) => {
      if (a.path === undefined || a.path === "") return ok({});
      const path = parseFilePath(a.path);
      return path ? ok({ path }) : fail('"path" must be a path ending in .md or .json');
    },
    run: async (store, { path }) => {
      const labels = parseLabels((await store.read(LABELS_PATH))?.text ?? "");
      return path ? labels.filter((l) => l.path === path) : labels;
    },
  }),
  add_label: op<{ path: FilePath; name: string; revision?: Revision }>({
    description: "Name a note's state at a revision (by default, as it is now), so you can find it, open it and restore it later.",
    input: { type: "object", properties: { path: PATH, name: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["path", "name"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (!name || name.length > 80) return fail('"name" must be 1 to 80 characters');
      return ok({ path, name, revision: count(a.revision) });
    },
    run: async (store, { path, name, revision }, author) => {
      const at = revision ?? (await store.read(path))?.revision;
      if (!at) throw new OperationError(`${path} has no saved version to label yet`);
      // The labels file is shared: re-read and try again if someone else wrote it meanwhile.
      for (let tries = 0; tries < 3; tries++) {
        const file = await store.read(LABELS_PATH);
        const labels = parseLabels(file?.text ?? "").filter((l) => !(l.path === path && l.name === name));
        const result = await store.write({ path: LABELS_PATH, text: labelsText([...labels, { name, path, revision: at }]), base: file?.revision ?? 0, author });
        if (result.status !== "conflict") return { name, path, revision: at };
      }
      throw new OperationError("The labels file kept changing; try again");
    },
  }),
  list_embeds: op<Record<string, never>>({
    description:
      "The embeds notes can hold, which extensions draw in place. Each comes with its name, its syntax, what it does, its key=value arguments, what its body holds (if anything), an example to copy, and whether its extension is on here. Write each the way its syntax says: a leaf is one line, `::timer{duration=25m label=\"Focus\"}`; a container wraps markdown, `:::kanban` on a line, its markdown, then `:::` on a line; a fence is a code block, its name and arguments on the opening line. Extensions installed from the Extensions view's Catalog add more.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store, _, author) => listEmbeds(store, author.kind === "user" ? author.email : author.kind === "agent" ? (author.by ?? null) : null),
  }),
  complete_task: op<{ path: FilePath; line: number; text?: string; done: boolean; today: string }>({
    description:
      "Tick a task (a `- [ ]` line), or untick it with done=false, the way the app does. A plain task gets `done:` and the day. A repeating one (`rec:`) moves on to its next date on the same line, with `last:` set to the day, and its completion is logged under ## Done in today's daily note (Journal/YYYY-MM-DD.md), unless the person's settings say otherwise. Use this rather than editing the line yourself. `today` is the person's day (YYYY-MM-DD) where they are, which is what done: and last: say. Both changes are yours; undo them together with both revisions.",
    input: {
      type: "object",
      properties: {
        path: PATH,
        line: { type: "integer", minimum: 1, description: "The task's line number, from 1" },
        text: { type: "string", description: "The task's line as you read it, so a note that changed meanwhile isn't ticked in the wrong place" },
        done: { type: "boolean", description: "false to untick it" },
        today: { type: "string", description: "The person's day where they are, YYYY-MM-DD" },
      },
      required: ["path", "line", "today"],
    },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const line = count(a.line);
      if (!path || !path.endsWith(".md")) return fail('"path" must be a note\'s path, ending in .md');
      if (!line) return fail('"line" must be the task\'s line number, from 1');
      if (typeof a.today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.today)) return fail('"today" must be the person\'s local date, as YYYY-MM-DD: the tick writes it as done: and last:');
      return ok({ path, line, text: typeof a.text === "string" ? a.text : undefined, done: a.done !== false, today: a.today });
    },
    run: async (store, args, author) => {
      const ticked = await store.completeTask(args, author);
      if ("refused" in ticked) throw new OperationError(ticked.refused);
      return ticked;
    },
  }),
  list_uploads: op<Record<string, never>>({
    description: "Uploaded files (images, PDFs and others), each with its name, size, type and the address notes link it by, like ![photo](/uploads/photo.png).",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store) => parseUploads((await store.read(UPLOADS_PATH))?.text ?? "").map((u) => ({ ...u, url: uploadUrl(u.name) })),
  }),
  upload_file: op<{ name: string; data: ArrayBuffer }>({
    description:
      "Upload a file, given its name and its bytes in base64. It's recorded as a change by you; link to it from a note with the url you get back, like ![photo](/uploads/photo.png). A name that's taken by another file gets a number added.",
    input: { type: "object", properties: { name: { type: "string" }, data: { type: "string", description: "The file's bytes, base64" } }, required: ["name", "data"] },
    parse: (a) => {
      if (typeof a.name !== "string" || !a.name.trim()) return fail('"name" must be the file\'s name, like "photo.png"');
      if (typeof a.data !== "string") return fail('"data" must be the file\'s bytes in base64');
      try {
        const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
        return ok({ name: a.name, data: bytes.buffer });
      } catch {
        return fail('"data" isn\'t valid base64');
      }
    },
    run: async (store, { name, data }, author) => {
      const result = await store.upload(name, data, author);
      if (result.status === "refused") throw new OperationError(result.error);
      return { status: result.status, ...result.upload, url: result.url };
    },
  }),
};

/** An operation couldn't be done, for a reason the caller can act on: it comes back as an error, not a crash. */
export class OperationError extends Error {}

export type OperationName = keyof typeof OPERATIONS;

export const isOperation = (name: string): name is OperationName => Object.hasOwn(OPERATIONS, name);

/** Parse and run an operation. */
export async function runOperation(name: OperationName, args: Args, store: Store, author: Author): Promise<Parsed<unknown>> {
  const operation = OPERATIONS[name] as Operation;
  const parsed = operation.parse(args);
  if (!parsed.ok) return parsed;
  try {
    return ok(await operation.run(store, parsed.value, author));
  } catch (err) {
    // Data sources fail in ways the caller can fix (connect Google); say how instead of a 500.
    if (name === "data_sources" || name === "list_contacts") return fail((err as Error).message);
    if (err instanceof OperationError) return fail(err.message);
    console.error("Operation failed:", name, err);
    return { ok: false, internal: true, error: `Something went wrong running ${name}. It's been logged; try again.` };
  }
}
