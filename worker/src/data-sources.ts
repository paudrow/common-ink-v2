// A person's data sources: whether Google is connected, and their events and contacts. In Previews
// and local development the recorded fixtures stand in for Google.
import type { Db } from "./files.ts";
import { accessToken, calendarEvents, contacts, DATA_SCOPES, type GoogleConfig, type Granted } from "./google.ts";
import { fixtures, matchesContact, type Contact, type Event } from "./sources.ts";

export interface SourceStatus {
  /** "fixtures": recorded sample data. "google": your Google account. "none": not connected. */
  using: "fixtures" | "google" | "none";
  /** Whether Google sign-in is set up here at all. */
  googleAvailable: boolean;
}

export interface SourceSettings {
  fixtures: boolean;
  google: GoogleConfig | null;
}

export class DataSources {
  constructor(
    private db: Db,
    private settings: SourceSettings,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  /** Keep the refresh token Google gave when this person connected their calendar and contacts. */
  connect(granted: Granted): boolean {
    if (!granted.refreshToken || !DATA_SCOPES.every((s) => granted.scopes.includes(s))) return false;
    this.db.run(
      "INSERT INTO connections(email, provider, refresh_token, scopes, time) VALUES (?, 'google', ?, ?, ?) ON CONFLICT(email, provider) DO UPDATE SET refresh_token = excluded.refresh_token, scopes = excluded.scopes, time = excluded.time",
      granted.email,
      granted.refreshToken,
      granted.scopes.join(" "),
      this.now(),
    );
    return true;
  }

  disconnect(email: string): void {
    this.db.run("DELETE FROM connections WHERE email = ? AND provider = 'google'", email);
  }

  status(email: string): SourceStatus {
    const googleAvailable = !!this.settings.google;
    if (this.settings.fixtures) return { using: "fixtures", googleAvailable };
    return { using: this.token(email) ? "google" : "none", googleAvailable };
  }

  async events(email: string, from: string, to: string): Promise<Event[]> {
    if (this.settings.fixtures) return fixtures.events(from, to);
    return calendarEvents(await this.access(email), from, to, this.fetcher);
  }

  async contacts(email: string, query: string): Promise<Contact[]> {
    if (this.settings.fixtures) return fixtures.contacts(query);
    return (await contacts(await this.access(email), this.fetcher)).filter((c) => matchesContact(c, query));
  }

  private token(email: string): string | null {
    return this.db.all<{ refresh_token: string }>("SELECT refresh_token FROM connections WHERE email = ? AND provider = 'google'", email)[0]?.refresh_token ?? null;
  }

  private async access(email: string): Promise<string> {
    const refresh = this.token(email);
    if (!refresh || !this.settings.google) throw new Error("Google isn't connected. Run Connect Google calendar and contacts.");
    return accessToken(this.settings.google, refresh, this.fetcher);
  }
}
