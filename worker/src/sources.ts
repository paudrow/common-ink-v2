// Data sources: outside data a workspace shows but doesn't store as notes (CONTEXT.md). Google
// Calendar gives events and Google Contacts gives contacts. Each source turns Google's answers into
// these shapes, so the rest of the app never sees Google's formats.
import calendarFixture from "./fixtures/google-calendar-events.json";
import peopleFixture from "./fixtures/google-people-connections.json";

export interface Event {
  id: string;
  title: string;
  /** YYYY-MM-DD for an all-day event, or an ISO time. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Whether it's one occurrence of a recurring event. */
  recurring: boolean;
  calendar: string;
}

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
}

interface GoogleTime {
  date?: string;
  dateTime?: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  start: GoogleTime;
  end: GoogleTime;
  location?: string;
  recurringEventId?: string;
  status?: string;
}

export interface GooglePerson {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string }>;
}

export function toEvent(e: GoogleEvent, calendar = "primary"): Event | null {
  if (e.status === "cancelled") return null;
  const allDay = !!e.start.date;
  const start = e.start.date ?? e.start.dateTime;
  const end = e.end.date ?? e.end.dateTime;
  if (!start || !end) return null;
  return { id: e.id, title: e.summary ?? "(no title)", start, end, allDay, location: e.location || undefined, recurring: !!e.recurringEventId, calendar };
}

export function toContact(p: GooglePerson): Contact | null {
  const name = p.names?.[0]?.displayName;
  if (!name) return null;
  const values = (list?: Array<{ value?: string }>) => (list ?? []).flatMap((x) => (x.value ? [x.value] : []));
  return { id: p.resourceName, name, emails: values(p.emailAddresses), phones: values(p.phoneNumbers), organization: p.organizations?.[0]?.name || undefined };
}

export function matchesContact(c: Contact, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [c.name, ...c.emails, c.organization ?? ""].some((s) => s.toLowerCase().includes(q));
}

/** Move an event by whole days, keeping its times of day. */
function shift(value: string, days: number): string {
  const allDay = value.length === 10;
  const d = new Date(allDay ? `${value}T00:00:00Z` : value);
  d.setUTCDate(d.getUTCDate() + days);
  return allDay ? d.toISOString().slice(0, 10) : d.toISOString();
}

/**
 * Recorded answers from Google, for Previews, local development and tests. The calendar's events are
 * moved so the recording's first day is today, so a Preview always has something this week.
 */
export const fixtures = {
  events(from: string, to: string, today = new Date().toISOString().slice(0, 10)): Event[] {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${calendarFixture.recordedOn}T00:00:00Z`)) / 86_400_000);
    return (calendarFixture.items as GoogleEvent[])
      .map((e) => ({ ...e, start: shiftTime(e.start, days), end: shiftTime(e.end, days) }))
      .map((e) => toEvent(e))
      .filter((e): e is Event => e !== null && e.end > from && e.start < to)
      .sort((a, b) => a.start.localeCompare(b.start));
  },
  contacts(query = ""): Contact[] {
    return (peopleFixture.connections as GooglePerson[])
      .map(toContact)
      .filter((c): c is Contact => c !== null && matchesContact(c, query))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
};

function shiftTime(t: GoogleTime, days: number): GoogleTime {
  return t.date ? { date: shift(t.date, days) } : { dateTime: shift(t.dateTime!, days) };
}
