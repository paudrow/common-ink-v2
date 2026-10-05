// Contacts, read from Google Contacts (or recorded fixtures) and turned into this shape, so the rest of
// the app never sees Google's format. Calendar events are records (calendar.ts, records.ts).
import peopleFixture from "./fixtures/google-people-connections.json";

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
}

export interface GooglePerson {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string }>;
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

/** Recorded answers from Google Contacts, for Previews, local development and tests. */
export const fixtures = {
  contacts(query = ""): Contact[] {
    return (peopleFixture.connections as GooglePerson[])
      .map(toContact)
      .filter((c): c is Contact => c !== null && matchesContact(c, query))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
};
