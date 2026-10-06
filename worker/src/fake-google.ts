// A fake Google Calendar for tests: the token endpoint, the calendar list, and events with sync
// tokens, pages, etags, recurring events' occurrences and their changes, 410 Gone once sync tokens
// expire, and invalid_grant once the grant is revoked. It answers as fetch does, so the Google adapter
// runs against it unchanged. It keeps only what the adapter uses.
import type { GoogleCalendarEntry, GoogleEvent, GoogleTime } from "./google-calendar.ts";

interface Stored {
  event: GoogleEvent;
  /** When it last changed, in the fake's change count. */
  seq: number;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number, message: string, reason = "") => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

export class FakeGoogle {
  private calendars = new Map<string, { entry: GoogleCalendarEntry; events: Map<string, Stored> }>();
  private seq = 0;
  /** Sync tokens carry this; expiring them bumps it, so every older token gets 410 Gone. */
  private generation = 1;
  revoked = false;
  /** Every request, as "METHOD path?query", for tests to read. */
  readonly calls: string[] = [];
  /** How many calendars a page of the calendar list holds at most: Google may page it below what was asked for. */
  calendarPage = 250;
  /** Events whose changes Google refuses (400), with what it says: an invalid field, or a rule of the calendar's. */
  readonly refusing = new Map<string, string>();

  addCalendar(entry: GoogleCalendarEntry): void {
    this.calendars.set(entry.id, { entry, events: new Map() });
  }

  /** An event made or changed in Google itself, as if from another device. */
  put(calendar: string, event: GoogleEvent): GoogleEvent {
    const events = this.cal(calendar).events;
    const seq = ++this.seq;
    const stored: GoogleEvent = { status: "confirmed", ...event, etag: `"${seq}"`, updated: new Date(1_790_000_000_000 + seq * 1000).toISOString(), htmlLink: `https://calendar.google.com/event?eid=${event.id}` };
    events.set(event.id, { event: stored, seq });
    return stored;
  }

  /** An event deleted in Google itself; a series goes with its changed occurrences. */
  remove(calendar: string, id: string): void {
    for (const { event } of [...this.cal(calendar).events.values()]) {
      if (event.id === id || event.recurringEventId === id) this.put(calendar, { ...event, status: "cancelled" });
    }
  }

  event(calendar: string, id: string): GoogleEvent | undefined {
    return this.cal(calendar).events.get(id)?.event;
  }

  /** Sync tokens stop working, as Google's do after a while: the next sync gets 410 Gone. */
  expireSyncTokens(): void {
    this.generation++;
  }

  private cal(id: string) {
    const c = this.calendars.get(id === "primary" ? ([...this.calendars.values()].find((c) => c.entry.primary)?.entry.id ?? id) : id);
    if (!c) throw new Error(`No calendar ${id}`);
    return c;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      this.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (this.revoked) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "fake-access", expires_in: 3599, token_type: "Bearer" });
    }
    // Revoking the grant ends the access tokens made from it too.
    if (this.revoked || new Headers(init.headers).get("Authorization") !== "Bearer fake-access") return error(401, "Invalid Credentials", "authError");
    const path = url.pathname.replace(/^\/calendar\/v3/, "");
    if (path === "/users/me/calendarList") {
      const all = [...this.calendars.values()].map((c) => c.entry);
      const size = Math.min(Number(url.searchParams.get("maxResults") ?? 100), this.calendarPage);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      return json({ items: all.slice(offset, offset + size), ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {}) });
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return error(404, "Not Found");
    let cal: ReturnType<FakeGoogle["cal"]>;
    try {
      cal = this.cal(decodeURIComponent(m[1]));
    } catch {
      return error(404, "Not Found", "notFound");
    }
    const calendarId = cal.entry.id;
    const id = m[2] && decodeURIComponent(m[2]);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as GoogleEvent) : null;
    const ifMatch = new Headers(init.headers).get("If-Match");
    if (!id && method === "GET") return this.list(cal.events, url.searchParams);
    const refusal = method !== "GET" && this.refusing.get(id ?? body?.id ?? "");
    if (refusal) return error(400, refusal, "invalid");
    if (!id && method === "POST") {
      if (!body?.id) return error(400, "Missing id");
      if (cal.events.has(body.id)) return error(409, "The requested identifier already exists.", "duplicate");
      return json(this.put(calendarId, body));
    }
    if (!id) return error(405, "Method not allowed");
    let current = cal.events.get(id)?.event;
    if (!current) {
      // An occurrence nobody changed yet: Google makes it from its series when it's changed.
      const occurrence = /^(.+)_(\d{8})(T(\d{2})(\d{2})(\d{2})Z)?$/.exec(id);
      const series = occurrence && cal.events.get(occurrence[1])?.event;
      if (!series || !occurrence) return error(404, "Not Found", "notFound");
      const day = `${occurrence[2].slice(0, 4)}-${occurrence[2].slice(4, 6)}-${occurrence[2].slice(6, 8)}`;
      const original: GoogleTime = occurrence[3] ? { dateTime: `${day}T${occurrence[4]}:${occurrence[5]}:${occurrence[6]}Z`, timeZone: series.start?.timeZone } : { date: day };
      const { recurrence: _, ...fields } = series;
      current = { ...fields, id, recurringEventId: series.id, originalStartTime: original, start: original, end: original };
    }
    // Google's get answers a deleted event too, cancelled.
    if (method === "GET") return json(current);
    if (ifMatch && current.etag && ifMatch !== current.etag) return error(412, "Precondition Failed", "conditionNotMet");
    if (method === "PATCH" && body) return json(this.put(calendarId, { ...current, ...body, id }));
    if (method === "DELETE") {
      if (current.status === "cancelled") return error(410, "Resource has been deleted", "deleted");
      if (cal.events.has(id)) this.remove(calendarId, id);
      else this.put(calendarId, { ...current, status: "cancelled" });
      return new Response(null, { status: 204 });
    }
    return error(405, "Method not allowed");
  };

  private list(events: Map<string, Stored>, q: URLSearchParams): Response {
    const token = q.get("syncToken");
    let since = 0;
    if (token) {
      const [gen, seq] = token.split(":").map(Number);
      if (gen !== this.generation) return error(410, "Sync token is no longer valid, a full sync is required.", "fullSyncRequired");
      since = seq;
    }
    if (q.get("singleEvents") === "true") return error(400, "The fake keeps series as series");
    // A full sync leaves out what's deleted, except a series' cancelled occurrences, as Google does
    // without singleEvents; an incremental one sends deletions too.
    const all = [...events.values()].filter((s) => s.seq > since && (token || s.event.status !== "cancelled" || s.event.recurringEventId)).sort((a, b) => a.seq - b.seq);
    const size = Number(q.get("maxResults") ?? 250);
    const offset = Number(q.get("pageToken") ?? 0);
    const page = all.slice(offset, offset + size).map((s) => s.event);
    const more = offset + size < all.length;
    return json({ items: page, ...(more ? { nextPageToken: String(offset + size) } : { nextSyncToken: `${this.generation}:${this.seq}` }) });
  }
}

/**
 * A fake Google with a week of events around `today`, a day in its calendars' zone (New York), for
 * the browser tests' Workers (FAKE_GOOGLE): a primary calendar with a weekday standup and a dentist
 * visit, and a team calendar you can only read.
 */
export const SAMPLE_ZONE = "America/New_York";

export function sampleGoogle(today: string): FakeGoogle {
  const NY = SAMPLE_ZONE;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const fake = new FakeGoogle();
  fake.addCalendar({ id: "tester@localhost", summary: "Tester", primary: true, accessRole: "owner", backgroundColor: "#4f6bd8", timeZone: NY });
  fake.addCalendar({ id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader", backgroundColor: "#2f9e44", timeZone: NY });
  fake.put("tester@localhost", { id: "standup", summary: "Standup", start: { dateTime: `${day(-7)}T09:00:00`, timeZone: NY }, end: { dateTime: `${day(-7)}T09:15:00`, timeZone: NY }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"] });
  fake.put("tester@localhost", { id: "dentist", summary: "Dentist", location: "12 High Street", start: { dateTime: `${day(1)}T14:30:00`, timeZone: NY }, end: { dateTime: `${day(1)}T15:15:00`, timeZone: NY } });
  fake.put("team@group.calendar.google.com", { id: "offsite", summary: "Offsite", start: { date: day(3) }, end: { date: day(5) } });
  return fake;
}
