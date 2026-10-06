// Google Calendar as a data source (ADR 0007): the adapter that pushes edits to the Calendar API and
// syncs Google's changes back, one sync token per calendar. Google's formats stop here; the rest of
// the app sees calendar.ts's events. Writes are PATCHes of the fields Common Ink models, so what it
// doesn't (guests, reminders, video calls) is left as Google has it.
import { fullWall, wallTimeAt, type Calendar, type CalendarEvent, type EventFields, type RecordOp } from "./calendar.ts";
import { Conflict, ReconnectNeeded, Refusal, type Adapter, type Pushed, type SyncIO } from "./adapter.ts";
import type { GoogleConfig } from "./google.ts";

/** An event as the Calendar API sends and takes it (the fields Common Ink uses). */
export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  location?: string;
  description?: string;
  colorId?: string;
  htmlLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  updated?: string;
}

export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  timeZone?: string;
  selected?: boolean;
}

const API = "https://www.googleapis.com/calendar/v3";

/** Google's primary calendar is "primary" in addresses, so a note's link doesn't name your email. */
const collectionOf = (entry: Pick<GoogleCalendarEntry, "id" | "primary">) => (entry.primary ? "primary" : entry.id);

export function calendarFromGoogle(entry: GoogleCalendarEntry): Calendar {
  return {
    id: collectionOf(entry),
    title: entry.summary,
    color: entry.backgroundColor && /^#[0-9a-f]{6}$/i.test(entry.backgroundColor) ? entry.backgroundColor.toLowerCase() : "#4f6bd8",
    ...(entry.primary ? { primary: true } : {}),
    writable: entry.accessRole === "owner" || entry.accessRole === "writer",
    ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
    ...(entry.selected === false ? { selected: false } : {}),
  };
}

/** A time as a day, or a wall time in `zone`. A dateTime without an offset is already one. */
function timeIn(t: GoogleTime, zone: string): { day: string } | { wall: string } | null {
  if (t.date) return { day: t.date };
  if (!t.dateTime) return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(t.dateTime)) return { wall: wallTimeAt(Date.parse(t.dateTime), zone) };
  const wall = fullWall(t.dateTime.slice(0, 19));
  return wall ? { wall } : null;
}

/**
 * Google's event as Common Ink's, in its calendar (`zone` is the calendar's). Times keep the event's
 * own zone. A cancelled occurrence comes with its original start only, and is kept that way.
 */
export function eventFromGoogle(g: GoogleEvent, calendar: string, calendarZone = "UTC"): CalendarEvent | null {
  const zone = g.start?.timeZone ?? g.originalStartTime?.timeZone ?? calendarZone;
  const start = timeIn(g.start ?? g.originalStartTime ?? {}, zone);
  const end = timeIn(g.end ?? g.start ?? g.originalStartTime ?? {}, zone);
  if (!start || !end) return null;
  const fields: EventFields = { id: g.id, calendar, title: g.summary ?? "", status: g.status ?? "confirmed" };
  if (g.location) fields.location = g.location;
  if (g.description) fields.description = g.description;
  if (g.colorId) fields.colorId = g.colorId;
  if (g.htmlLink) fields.link = g.htmlLink;
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const timing =
    "day" in start
      ? { allDay: true as const, start: start.day, end: "day" in end && end.day > start.day ? end.day : nextDay(start.day) }
      : { allDay: false as const, start: start.wall, end: "wall" in end && end.wall >= start.wall ? end.wall : start.wall, timeZone: zone };
  if (g.recurringEventId && g.originalStartTime) {
    const original = timeIn(g.originalStartTime, g.originalStartTime.timeZone ?? zone);
    if (!original) return null;
    return { ...fields, ...timing, series: g.recurringEventId, originalStart: "day" in original ? original.day : original.wall };
  }
  if (g.recurrence?.length) return { ...fields, ...timing, recurrence: g.recurrence };
  return { ...fields, ...timing };
}

/** What a PATCH (or an insert) sends: every field Common Ink models, with nulls to clear the others' ways of saying times. */
export function eventToGoogle(e: CalendarEvent, calendarZone: string | undefined): Record<string, unknown> {
  const zone = e.allDay ? undefined : (e.timeZone ?? calendarZone ?? "UTC");
  const time = (v: string) => (e.allDay ? { date: v, dateTime: null, timeZone: null } : { dateTime: v, timeZone: zone, date: null });
  return {
    summary: e.title,
    location: e.location ?? "",
    description: e.description ?? "",
    status: e.status,
    ...(e.colorId ? { colorId: e.colorId } : {}),
    start: time(e.start),
    end: time(e.end),
    ...(e.series === undefined ? { recurrence: e.recurrence ?? [] } : {}),
  };
}

/** Reasons Google gives a 403 for that pass: too many requests for now. */
const BUSY = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

/**
 * Why a push failed, as an error flush can act on: a Refusal when Google won't take the change as
 * it is (a 4xx), else an error to try again later (5xx, too many requests).
 */
async function failure(res: Response, doing: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | null;
  const message = body?.error?.message;
  const busy = res.status === 408 || res.status === 429 || (res.status === 403 && BUSY.has(body?.error?.errors?.[0]?.reason ?? ""));
  if (res.status >= 400 && res.status < 500 && !busy) return new Refusal(message || `Google answered ${res.status}`);
  return new Error(`Google Calendar answered ${res.status} ${doing}${message ? `: ${message}` : ""}`);
}

export class GoogleCalendar implements Adapter {
  readonly source = "google";
  readonly title = "Google Calendar";
  private token: { value: string; until: number } | null = null;
  private zones = new Map<string, string>();

  constructor(
    private config: GoogleConfig,
    /** The connected person's refresh token, or null if nobody's connected. */
    private refreshToken: () => Promise<string | null>,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private async access(fresh = false): Promise<string> {
    if (!fresh && this.token && this.token.until > this.now() + 60_000) return this.token.value;
    const refresh = await this.refreshToken();
    if (!refresh) throw new ReconnectNeeded("Google Calendar isn't connected");
    const res = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (body.error === "invalid_grant") throw new ReconnectNeeded("Google ended Common Ink's access to your calendar (it does that after 7 days while the app is in testing). Reconnect Google Calendar.");
    if (!res.ok || !body.access_token) throw new Error(`Google's sign-in answered ${res.status}`);
    this.token = { value: body.access_token, until: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** A Calendar API call, signed in, once more with a fresh token if Google says the old one's no good. */
  private async call(method: string, path: string, init: { body?: unknown; etag?: string | null; query?: Record<string, string> } = {}): Promise<Response> {
    const url = `${API}${path}${init.query ? `?${new URLSearchParams(init.query)}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.access(attempt > 0)}` };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      if (init.etag) headers["If-Match"] = init.etag;
      const res = await this.fetcher(url, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401 || res.status === 403) {
        const reason = ((await res.clone().json().catch(() => null)) as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason;
        if (res.status === 401 || reason === "insufficientPermissions" || reason === "authError") throw new ReconnectNeeded("Common Ink needs your permission to change your calendar. Reconnect Google Calendar.");
      }
      return res;
    }
  }

  private path(calendar: string, id?: string) {
    return `/calendars/${encodeURIComponent(calendar)}/events${id ? `/${encodeURIComponent(id)}` : ""}`;
  }

  async push(op: RecordOp, etag: string | null, calendar?: Calendar): Promise<Pushed> {
    const e = op.event;
    if (calendar?.timeZone) this.zones.set(calendar.id, calendar.timeZone);
    if (op.op === "delete") {
      const res = await this.call("DELETE", this.path(e.calendar, e.id), { etag });
      if (res.status === 412) {
        const now = await this.current(e);
        // Gone already is what we wanted.
        if (!now || now.status === "cancelled") return {};
        throw this.conflict(e, now);
      }
      if (!res.ok && res.status !== 404 && res.status !== 410) throw await failure(res, `deleting ${e.title || e.id}`);
      return {};
    }
    const body = eventToGoogle(e, this.zones.get(e.calendar));
    // A new event keeps the id we gave it; a changed occurrence is made by changing it where Google keeps it.
    const res = op.created && e.series === undefined ? await this.call("POST", this.path(e.calendar), { body: { ...body, id: e.id } }) : await this.call("PATCH", this.path(e.calendar, e.id), { body, etag });
    if (res.status === 412) {
      const now = await this.current(e);
      if (!now) throw new Refusal("It was deleted in Google");
      throw this.conflict(e, now);
    }
    if (res.status === 409) return this.push({ op: "put", event: e, created: false }, null, calendar);
    if (res.status === 404 || res.status === 410) throw new Refusal("It was deleted in Google");
    if (!res.ok) throw await failure(res, `saving ${e.title || e.id}`);
    return { etag: ((await res.json()) as GoogleEvent).etag };
  }

  /**
   * The event as Google has it now, or null if Google deleted it: Google answers a deleted event
   * cancelled, or 404 or 410. An occurrence cancelled on its own is still its series', so it's
   * merged with like any change. If Google can't say, that's a failure for now: the edit waits with
   * the etag it has, so it never goes out without one.
   */
  private async current(e: CalendarEvent): Promise<GoogleEvent | null> {
    const res = await this.call("GET", this.path(e.calendar, e.id));
    if (res.status === 404 || res.status === 410) return null;
    // Not knowing how Google has it isn't a reason to drop the edit: it waits and tries again.
    if (!res.ok) throw new Error(`Google Calendar answered ${res.status} reading ${e.title || e.id}`);
    const g = (await res.json()) as GoogleEvent;
    return g.status === "cancelled" && !g.recurringEventId ? null : g;
  }

  /** Google's version of an event, for merging with ours. */
  private conflict(e: CalendarEvent, g: GoogleEvent): Conflict {
    return new Conflict(eventFromGoogle(g, e.calendar, this.zones.get(e.calendar)), g.etag ?? null);
  }

  /**
   * Bring Google's changes in: the calendar list, then each calendar's events since its sync token
   * (all of them the first time, or when Google says the token's too old).
   */
  async sync(io: SyncIO): Promise<void> {
    const listed = await this.call("GET", "/users/me/calendarList", { query: { maxResults: "250" } });
    if (!listed.ok) throw new Error(`Google Calendar answered ${listed.status} listing calendars`);
    const entries = ((await listed.json()) as { items?: GoogleCalendarEntry[] }).items ?? [];
    const calendars = entries.filter((c) => c.accessRole !== "freeBusyReader");
    for (const c of calendars) this.zones.set(collectionOf(c), c.timeZone ?? "UTC");
    io.calendars(calendars.map(calendarFromGoogle));
    for (const entry of calendars) await this.syncCalendar(io, collectionOf(entry), entry.timeZone ?? "UTC");
  }

  private async syncCalendar(io: SyncIO, calendar: string, zone: string): Promise<void> {
    let token = io.token(calendar);
    const seen = new Set<string>();
    let page: string | undefined;
    for (;;) {
      const query: Record<string, string> = { maxResults: "250", ...(token ? { syncToken: token } : { showDeleted: "false" }), ...(page ? { pageToken: page } : {}) };
      const res = await this.call("GET", this.path(calendar), { query });
      if (res.status === 410 && token) {
        // The token's too old: start again from nothing, and drop what Google no longer has.
        token = null;
        page = undefined;
        seen.clear();
        continue;
      }
      if (!res.ok) throw new Error(`Google Calendar answered ${res.status} syncing ${calendar}`);
      const body = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      for (const g of body.items ?? []) {
        seen.add(g.id);
        if (g.status === "cancelled" && !g.recurringEventId) io.remove(calendar, g.id);
        else {
          const e = eventFromGoogle(g, calendar, zone);
          if (e) io.put(e, g.etag ?? null);
        }
      }
      page = body.nextPageToken;
      if (page) continue;
      if (!token) io.prune(calendar, seen);
      io.setToken(calendar, body.nextSyncToken ?? null);
      return;
    }
  }
}
