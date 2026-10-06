// Data sources (ADR 0007): outside data a workspace shows but doesn't keep as notes. A source's
// records live in record files with history (records.ts). Edits go through here: they're written as
// the person's (or agent's) changes at once, queued in the outbox, and pushed to the source by its
// adapter; what the source changes comes back through sync as changes by its sync. The Sample
// calendar is a source with nothing behind it, so Previews and local development behave the same
// way without Google. Contacts are read straight from Google (or recorded fixtures) for now.
import { findTarget, mergeEvents, newEventId, occurrences, parseTiming, planDelete, planRevert, planUpdate, type Calendar, type CalendarEvent, type EventChange, type EventTiming, type Occurrence, type RecordOp, type Scope } from "./calendar.ts";
import { authorKey, Files, type Author, type ChangeNotice, type Db, type FilePath, type Revision, type UndoResult, type Write, type WriteResult } from "./files.ts";
import { accessToken, contacts, DATA_SCOPES, type GoogleConfig, type Granted } from "./google.ts";
import { Conflict, ReconnectNeeded, Refusal, Unreadable, type Adapter, type Pushed, type SyncIO } from "./adapter.ts";
import { GoogleCalendar } from "./google-calendar.ts";
import { addressOf, isRecordPath, keyOfPath, parseAddress, readEvent, recordPath, recordText, Records, RECORDS_DIR, type SourceId } from "./records.ts";
import { fixtures, matchesContact, type Contact } from "./sources.ts";
import { isSealed, seal, unseal } from "./token-seal.ts";

/** A note that links to an event; `series` when it links to the event's series rather than this occurrence. */
export interface LinkingNote {
  path: FilePath;
  title: string;
  series?: true;
}

/** Where a source stands, for the Data sources view and agents. */
export interface SourceState {
  source: SourceId;
  kind: "calendar";
  title: string;
  /** "needs-reconnect": the source refused our sign-in (Google's test apps end it after 7 days). "error": the last push or sync failed. */
  state: "ok" | "needs-reconnect" | "error" | "not-connected";
  lastSync: number | null;
  error?: string;
  calendars: number;
  events: number;
  /** Edits made here that the source hasn't taken yet. */
  pending: number;
  /** The last edit here the source didn't take as it was: changed there too (and which side won), or refused. */
  conflict?: string;
}

export interface SourceStatus {
  /** "fixtures": recorded sample data. "google": your Google account. "none": not connected. */
  using: "fixtures" | "google" | "none";
  /** Whether Google sign-in is set up here at all. */
  googleAvailable: boolean;
  sources: SourceState[];
}

export interface SourceSettings {
  /** Previews and local development: the Sample calendar and recorded contacts stand in for Google. */
  fixtures: boolean;
  google: GoogleConfig | null;
  /** The secret refresh tokens are sealed under at rest (token-seal.ts). Without one they're kept as Google gave them. */
  tokenKey?: string;
}

/** The Sample calendar: nothing behind it, so every push is taken as it is. */
const sample: Adapter = { source: "sample", title: "Sample calendar", push: async () => ({}) };

/** An edit to events, as people and agents ask for one. */
export type EventEdit =
  | { op: "create"; id?: string; calendar?: string; title: string; timing: EventTiming; location?: string; description?: string; recurrence?: string[] }
  | { op: "update"; address: string; change: EventChange; scope: Scope }
  | { op: "delete"; address: string; scope: Scope };

/** What an edit did: its records as written, and whether the source has them yet. */
export interface EditResult {
  status: "saved" | "queued";
  /** The record the edit was about: the new event, the one edited, or the new series a split made. */
  address: string;
  written: CalendarEvent[];
  deleted: string[];
  /** Why the source doesn't have it yet, if it doesn't. */
  error?: string;
}

/** An edit that couldn't be made, and why, in words the caller can act on. It's an answer, not a throw, so it crosses the Durable Object's boundary as it is. */
export interface Refused {
  status: "refused";
  error: string;
}

class EditError extends Error {}

/** How long an edit waits for the source to say how its record is, before it's refused. */
const UNREADABLE_FOR = 30 * 60_000;

/** Who a source's sync is, as the author of what it brings in. */
const SYNC_AUTHOR: Record<SourceId, Extract<Author, { kind: "sync" }>> = { google: { kind: "sync", source: "google-calendar" }, sample: { kind: "sync", source: "sample-calendar" } };

interface StateRow {
  lastSync?: number;
  error?: string;
  reconnect?: boolean;
  /** The last edit here the source didn't take as it was, in words. */
  conflict?: string;
  /** Sync tokens, by calendar. */
  tokens?: Record<string, string>;
  /** Events a sync left as they were here, by calendar, for the next sync to read again. */
  recheck?: Record<string, string[]>;
}

export class DataSources {
  private adapters: Partial<Record<SourceId, Adapter>>;
  /** The flush running now: flushes take turns, so no edit goes out twice. */
  private flushing: Promise<unknown> = Promise.resolve();
  /** The sync running now, and the one after it: syncs take turns, so an older page can't land after a newer one. */
  private syncing: Promise<SourceState> | null = null;
  private again: Promise<SourceState> | null = null;
  /** Why the source refused queued edits, by outbox seq, until the edit that queued them reads it. */
  private refusals = new Map<number, string>();
  /** The record whose edit is being pushed now, if any. */
  private pushing: string | null = null;

  constructor(
    private db: Db,
    private files: Files,
    readonly records: Records,
    private settings: SourceSettings,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
    adapters: Adapter[] = [],
  ) {
    // `base` is the record as it was before the edit, for merging if the source changed it meanwhile.
    db.run("CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, author TEXT NOT NULL, time INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, base TEXT)");
    // `unreadable`: since when the source has kept refusing to say how the edit's record is, if it has.
    if (!/[(,\s]unreadable\s/.test(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'")[0]?.sql ?? "")) db.run("ALTER TABLE outbox ADD COLUMN unreadable INTEGER");
    db.run("CREATE TABLE IF NOT EXISTS etags(path TEXT PRIMARY KEY, etag TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS source_state(source TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const google = settings.google ? [new GoogleCalendar(settings.google, () => this.opened(this.connectedToken()), fetcher, now)] : [];
    this.adapters = Object.fromEntries([sample, ...google, ...adapters].map((a) => [a.source, a]));
  }

  /** The calendar source in use: the Sample calendar in Previews and local development, else Google. */
  get calendarSource(): SourceId {
    return this.settings.fixtures ? "sample" : "google";
  }

  // ---------------------------------------------------------------- connections

  /** Keep the refresh token Google gave when this person connected their calendar and contacts, sealed if there's a key. */
  async connect(granted: Granted): Promise<boolean> {
    if (!granted.refreshToken || !DATA_SCOPES.every((s) => granted.scopes.includes(s))) return false;
    const kept = this.settings.tokenKey ? await seal(this.settings.tokenKey, granted.refreshToken) : granted.refreshToken;
    this.db.run(
      "INSERT INTO connections(email, provider, refresh_token, scopes, time) VALUES (?, 'google', ?, ?, ?) ON CONFLICT(email, provider) DO UPDATE SET refresh_token = excluded.refresh_token, scopes = excluded.scopes, time = excluded.time",
      granted.email,
      kept,
      granted.scopes.join(" "),
      this.now(),
    );
    this.setState("google", { reconnect: false, error: undefined });
    return true;
  }

  /** Forget this person's connection, after telling Google to end the grant (if it can't be reached, the grant still goes from here). */
  async disconnect(email: string): Promise<void> {
    const token = await this.opened(this.token(email));
    if (token && this.settings.google) {
      await this.fetcher("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }).catch(() => {});
    }
    this.db.run("DELETE FROM connections WHERE email = ? AND provider = 'google'", email);
  }

  /** Seal any refresh token kept before tokens were sealed. Safe to run again. */
  async sealTokens(): Promise<void> {
    const key = this.settings.tokenKey;
    if (!key) return;
    for (const { email, refresh_token } of this.db.all<{ email: string; refresh_token: string }>("SELECT email, refresh_token FROM connections")) {
      if (isSealed(refresh_token)) continue;
      this.db.run("UPDATE connections SET refresh_token = ? WHERE email = ? AND refresh_token = ?", await seal(key, refresh_token), email, refresh_token);
    }
  }

  /** A kept refresh token, opened; null if there's none, or it was sealed under another key. */
  private async opened(kept: string | null): Promise<string | null> {
    return kept === null ? null : unseal(this.settings.tokenKey, kept);
  }

  status(email: string): SourceStatus {
    const googleAvailable = !!this.settings.google;
    const using = this.settings.fixtures ? "fixtures" : this.token(email) || this.connectedToken() ? "google" : "none";
    return { using, googleAvailable, sources: [this.sourceState(this.calendarSource, using !== "none")] };
  }

  private sourceState(source: SourceId, connected: boolean): SourceState {
    const counts = this.records.counts().filter((c) => c.source === source);
    const count = (kind: string) => counts.find((c) => c.kind === kind)?.count ?? 0;
    const st = this.state(source);
    const [{ pending }] = this.db.all<{ pending: number }>("SELECT count(*) AS pending FROM outbox WHERE source = ?", source);
    return {
      source,
      kind: "calendar",
      title: this.adapters[source]?.title ?? "Google Calendar",
      state: !connected ? "not-connected" : st.reconnect ? "needs-reconnect" : st.error ? "error" : "ok",
      lastSync: st.lastSync ?? null,
      ...(st.error ? { error: st.error } : {}),
      ...(st.conflict ? { conflict: st.conflict } : {}),
      calendars: count("calendar"),
      events: count("event"),
      pending,
    };
  }

  private state(source: SourceId): StateRow {
    const [row] = this.db.all<{ value: string }>("SELECT value FROM source_state WHERE source = ?", source);
    return row ? (JSON.parse(row.value) as StateRow) : {};
  }

  private setState(source: SourceId, change: Partial<StateRow>) {
    const next: StateRow = { ...this.state(source), ...change };
    for (const k of Object.keys(next) as Array<keyof StateRow>) if (next[k] === undefined) delete next[k];
    this.db.run("INSERT INTO source_state(source, value) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET value = excluded.value", source, JSON.stringify(next));
  }

  /** The refresh token sync uses: the workspace's latest Google connection. */
  private connectedToken(): string | null {
    return this.db.all<{ refresh_token: string }>("SELECT refresh_token FROM connections WHERE provider = 'google' ORDER BY time DESC LIMIT 1")[0]?.refresh_token ?? null;
  }

  private token(email: string): string | null {
    return this.db.all<{ refresh_token: string }>("SELECT refresh_token FROM connections WHERE email = ? AND provider = 'google'", email)[0]?.refresh_token ?? null;
  }

  private async access(email: string): Promise<string> {
    const refresh = await this.opened(this.token(email));
    if (!refresh || !this.settings.google) throw new Error("Google isn't connected. Run Connect Google calendar and contacts.");
    return accessToken(this.settings.google, refresh, this.fetcher);
  }

  async contacts(email: string, query: string): Promise<Contact[]> {
    if (this.settings.fixtures) return fixtures.contacts(query);
    return (await contacts(await this.access(email), this.fetcher)).filter((c) => matchesContact(c, query));
  }

  // ---------------------------------------------------------------- reading

  private readAll<T>(paths: readonly FilePath[], read: (text: string) => T | null): T[] {
    return paths.map((p) => this.files.read(p)).flatMap((f) => (f ? [read(f.text)] : [])).filter((x): x is T => x !== null);
  }

  /** The calendars of the source in use, the primary one first. */
  calendars(source: SourceId = this.calendarSource): Calendar[] {
    return this.readAll(this.records.all(source, "calendar"), readCalendar).sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || a.title.localeCompare(b.title));
  }

  /** Every time events happen between two instants, seen from a time zone, in the calendars named (all, by default). */
  events(from: number, to: number, zone: string, calendars?: readonly string[]): Occurrence[] {
    const source = this.calendarSource;
    const events = this.readAll(this.records.eventsBetween(source, from, to, calendars), readEvent);
    return occurrences(events, { from, to, zone }, (calendar, id) => addressOf({ source, collection: calendar, id }));
  }

  /**
   * An event by its address: as stored, or worked out from its series, with its series and the notes
   * that link to it (or to its series). Null if there's none.
   */
  event(address: string, zone = "UTC"): { address: string; event: CalendarEvent; series?: CalendarEvent; path: FilePath | null; notes: LinkingNote[] } | null {
    const key = parseAddress(address);
    if (!key) return null;
    const target = findTarget(this.family(key.source, key.collection, key.id), key.id, zone);
    if (!target) return null;
    const series = target.kind === "occurrence" ? target.series : target.series;
    const own = addressOf(key);
    const notes = this.linking([own, ...(series ? [addressOf({ ...key, id: series.id })] : [])]);
    if (target.kind === "occurrence") return { address, event: target.occurrence, series: target.series, path: null, notes };
    return { address, event: target.event, ...(target.series ? { series: target.series } : {}), path: recordPath(key), notes };
  }

  /** The notes with a link to any of some addresses, `[…](event:…)`, each with its title and whether it links to the first. */
  private linking(addresses: readonly string[]): LinkingNote[] {
    return this.files.notesWith(addresses.map((a) => `](${a})`)).map((f) => ({
      path: f.path,
      title: /^#\s+(.+)$/m.exec(f.text)?.[1].trim() ?? f.path.replace(/\.md$/, ""),
      ...(f.text.includes(`](${addresses[0]})`) ? {} : { series: true as const }),
    }));
  }

  /** An event's own record, its series, and the series' changed occurrences: what an edit of it may touch. */
  private family(source: SourceId, calendar: string, id: string): CalendarEvent[] {
    const fromId = /^(.+)_\d{8}(T\d{6}Z?)?$/.exec(id)?.[1];
    const own = this.readAll(this.records.family(source, calendar, fromId ? [id, fromId] : [id]), readEvent);
    const series = own.find((e) => e.id === id)?.series;
    if (!series || series === fromId) return own;
    return [...own, ...this.readAll(this.records.family(source, calendar, [series]), readEvent).filter((e) => !own.some((o) => o.id === e.id))];
  }

  // ---------------------------------------------------------------- editing

  /** Make an edit: write its records as `author`'s changes, then push them to the source. */
  async edit(edit: EventEdit, author: Author, zone = "UTC"): Promise<EditResult | Refused> {
    try {
      return await this.planned(edit, author, zone);
    } catch (err) {
      if (err instanceof EditError) return { status: "refused", error: err.message };
      throw err;
    }
  }

  private async planned(edit: EventEdit, author: Author, zone: string): Promise<EditResult | Refused> {
    if (edit.op === "create") {
      const source = this.calendarSource;
      const calendars = this.calendars();
      const calendar = edit.calendar ? calendars.find((c) => c.id === edit.calendar) : (calendars.find((c) => c.primary && c.writable) ?? calendars.find((c) => c.writable));
      if (!calendar) throw new EditError(edit.calendar ? `There's no calendar "${edit.calendar}"` : "There's no calendar to add events to");
      if (!calendar.writable) throw new EditError(`${calendar.title} can't be changed here`);
      const id = edit.id ?? newEventId();
      const address = addressOf({ source, collection: calendar.id, id });
      // Sent again (its answer was lost, say): it's made already.
      const made = this.files.read(recordPath({ source, kind: "event", collection: calendar.id, id }));
      if (made) return { status: "saved", address, written: [readEvent(made.text)].filter((e): e is CalendarEvent => !!e), deleted: [] };
      const fields = {
        id,
        calendar: calendar.id,
        title: edit.title,
        status: "confirmed" as const,
        ...(edit.location ? { location: edit.location } : {}),
        ...(edit.description ? { description: edit.description } : {}),
        ...edit.timing,
      };
      const event: CalendarEvent = edit.recurrence?.length ? { ...fields, recurrence: edit.recurrence } : fields;
      return this.apply(source, [{ op: "put", event, created: true }], author, address);
    }
    const key = parseAddress(edit.address);
    if (!key) throw new EditError(`"${edit.address}" isn't an event's address, like event:google/primary/abc123`);
    const calendar = this.calendars().find((c) => c.id === key.collection);
    if (calendar && !calendar.writable) throw new EditError(`${calendar.title} can't be changed here`);
    const family = this.family(key.source, key.collection, key.id);
    const target = findTarget(family, key.id, zone);
    if (!target) throw new EditError(`There's no event at ${edit.address}`);
    const ops = edit.op === "update" ? planUpdate(family, target, edit.change, edit.scope, () => newEventId(), zone) : planDelete(family, target, edit.scope, zone);
    const split = ops.find((o) => o.op === "put" && o.created && o.event.series === undefined && o.event.id !== key.id);
    return this.apply(key.source, ops, author, split ? addressOf({ source: key.source, collection: split.event.calendar, id: split.event.id }) : edit.address);
  }

  /** Write ops as `author`'s changes and queue them for the source, in one transaction; then push what's queued. */
  private async apply(source: SourceId, ops: RecordOp[], author: Author, address: string, undoes?: Revision): Promise<EditResult | Refused> {
    const writes: Array<{ op: RecordOp; write: Write; before: string | null }> = [];
    for (const op of ops) {
      const path = recordPath({ source, kind: "event", collection: op.event.calendar, id: op.event.id });
      const current = this.files.read(path);
      const base = current?.revision ?? 0;
      // Deleting a record that was never written (an occurrence nobody changed) has nothing to do.
      if (op.op === "delete" && !base) continue;
      const write: Write = op.op === "put" ? { path, text: recordText(op.event), base, author } : { path, text: "", base, author, delete: true };
      writes.push({ op, write: undoes !== undefined && op === ops[0] ? { ...write, undoes } : write, before: current?.text ?? null });
    }
    const queued: number[] = [];
    this.files.writeAll(
      writes.map((w) => w.write),
      () => {
        for (const { op, write, before } of writes) {
          const [{ seq }] = this.db.all<{ seq: number }>("INSERT INTO outbox(source, path, op, author, time, base) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq", source, write.path, JSON.stringify(op), authorKey(author), this.now(), before);
          queued.push(seq);
        }
      },
    );
    const error = await this.flush(source);
    const refusal = queued.map((seq) => this.refusals.get(seq)).find(Boolean);
    for (const seq of queued) this.refusals.delete(seq);
    if (refusal) return { status: "refused", error: refusal };
    return {
      status: error ? "queued" : "saved",
      address,
      written: ops.filter((o) => o.op === "put").map((o) => o.event),
      deleted: ops.filter((o) => o.op === "delete").map((o) => addressOf({ source, collection: o.event.calendar, id: o.event.id })),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Push queued edits to their source, oldest first, stopping at the first that fails for now, since
   * later ones may build on it. An edit the source refuses is dropped (see refuse) so the rest go on.
   * Returns why it stopped, or null once the outbox is empty. Running it again after a crash sends
   * what's left; an edit the source took but we didn't hear back about is sent again, which writes the
   * same record.
   */
  flush(source: SourceId): Promise<string | null> {
    const run = this.flushing.then(() => this.flushQueued(source));
    this.flushing = run.catch(() => undefined);
    return run;
  }

  private async flushQueued(source: SourceId): Promise<string | null> {
    const adapter = this.adapters[source];
    const conflicts = new Map<number, number>();
    for (;;) {
      const [row] = this.db.all<{ seq: number; path: string; op: string; base: string | null; unreadable: number | null }>("SELECT seq, path, op, base, unreadable FROM outbox WHERE source = ? ORDER BY seq LIMIT 1", source);
      if (!row) return null;
      if (!adapter) return "Google Calendar isn't connected";
      const op = JSON.parse(row.op) as RecordOp;
      const etag = this.db.all<{ etag: string }>("SELECT etag FROM etags WHERE path = ?", row.path)[0]?.etag ?? null;
      try {
        this.pushing = row.path;
        let pushed: Pushed;
        try {
          pushed = await adapter.push(op, etag, this.calendars(source).find((c) => c.id === op.event.calendar));
        } finally {
          // In the same step as the row goes below, so no sync sees the row while nothing is pushing it.
          this.pushing = null;
        }
        this.db.tx(() => {
          this.db.run("DELETE FROM outbox WHERE seq = ?", row.seq);
          if (op.op === "delete") this.db.run("DELETE FROM etags WHERE path = ?", row.path);
          else if (pushed.etag) this.setEtag(row.path, pushed.etag);
        });
        this.setState(source, { error: undefined });
      } catch (err) {
        if (err instanceof Conflict) {
          // Merged onto Google's version either way, so the next try has its etag. Three in one flush and it waits for the next.
          const tries = (conflicts.get(row.seq) ?? 0) + 1;
          conflicts.set(row.seq, tries);
          this.resolve(source, row, op, err);
          if (tries < 3) continue;
          this.db.run("UPDATE outbox SET error = ? WHERE seq = ?", err.message, row.seq);
          this.setState(source, { error: err.message });
          return err.message;
        }
        // Unreadable for half an hour of tries, it's refused, so the edits behind it aren't held for good.
        const unreadable = err instanceof Unreadable ? (row.unreadable ?? this.now()) : null;
        if (err instanceof Refusal || (unreadable !== null && this.now() - unreadable >= UNREADABLE_FOR)) {
          this.refusals.set(row.seq, this.refuse(source, adapter.title, row, op, (err as Error).message));
          continue;
        }
        const message = (err as Error).message;
        this.db.run("UPDATE outbox SET attempts = attempts + 1, error = ?, unreadable = ? WHERE seq = ?", message, unreadable, row.seq);
        this.setState(source, err instanceof ReconnectNeeded ? { reconnect: true } : { error: message });
        return message;
      }
    }
  }

  /**
   * The source changed a record while our edits of it waited. Merge each, field by field from what it
   * started from, onto the source's version and the edits before it (the source's side wins where
   * both changed one thing); write the result as the sync's change, and send them again against the
   * source's version.
   */
  private resolve(source: SourceId, row: { seq: number; path: string; base: string | null }, op: RecordOp, conflict: Conflict) {
    const bookkeeping = () => {
      this.db.run("UPDATE outbox SET attempts = attempts + 1 WHERE seq = ?", row.seq);
      if (conflict.etag) this.setEtag(row.path, conflict.etag);
      else this.db.run("DELETE FROM etags WHERE path = ?", row.path);
    };
    if (op.op === "delete" || !conflict.remote) return this.db.tx(bookkeeping);
    const queued = this.db.all<{ seq: number; op: string; base: string | null }>("SELECT seq, op, base FROM outbox WHERE path = ? AND seq >= ? ORDER BY seq", row.path, row.seq);
    let theirs = conflict.remote;
    const lost = new Set<string>();
    const rebased: Array<{ seq: number; op: RecordOp; base: string }> = [];
    for (const r of queued) {
      const o = JSON.parse(r.op) as RecordOp;
      // A delete waiting after them wins, whatever they merge to.
      if (o.op === "delete") break;
      const merged = mergeEvents(r.base ? readEvent(r.base) : null, o.event, theirs);
      for (const field of merged.lost) lost.add(field);
      rebased.push({ seq: r.seq, op: { ...o, event: merged.event, created: false }, base: recordText(theirs) });
      theirs = merged.event;
    }
    const current = this.files.read(row.path as FilePath);
    const text = recordText(theirs);
    const write = rebased.length === queued.length && current?.text !== text ? [{ path: row.path as FilePath, text, base: current?.revision ?? 0, author: SYNC_AUTHOR[source] }] : [];
    this.files.writeAll(write, () => {
      bookkeeping();
      for (const r of rebased) this.db.run("UPDATE outbox SET op = ?, base = ? WHERE seq = ?", JSON.stringify(r.op), r.base, r.seq);
    });
    if (lost.size) this.setState(source, { conflict: `${theirs.title || "An event"}: Google's ${[...lost].join(" and ")} replaced yours, which is still in its history` });
  }

  /**
   * The source won't take an edit. Drop it and the record's edits queued after it (they build on it,
   * and are sent whole), and put the record back as it was before them, as the sync's change: what the
   * source has. History keeps the edits. Returns why, in words.
   */
  private refuse(source: SourceId, title: string, row: { seq: number; path: string; base: string | null }, op: RecordOp, reason: string): string {
    const path = row.path as FilePath;
    const current = this.files.read(path);
    const author = SYNC_AUTHOR[source];
    const restore: Write[] = row.base === null ? (current ? [{ path, text: "", base: current.revision, author, delete: true }] : []) : current?.text === row.base ? [] : [{ path, text: row.base, base: current?.revision ?? 0, author }];
    this.files.writeAll(restore, () => this.db.run("DELETE FROM outbox WHERE path = ? AND seq >= ?", path, row.seq));
    const message = `${title} refused the change to ${op.event.title || "an event"}: ${reason.replace(/\.$/, "")}. It's back as it was, and the change is in its history.`;
    this.setState(source, { conflict: message, error: undefined });
    return message;
  }

  private setEtag(path: string, etag: string) {
    this.db.run("INSERT INTO etags(path, etag) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET etag = excluded.etag", path, etag);
  }

  /**
   * Bring the calendar source's own changes in, after sending what's waiting. Each record it changes
   * is a change by its sync. Safe to run again at any point: it picks up from its sync tokens.
   */
  sync(): Promise<SourceState> {
    if (!this.syncing) return (this.syncing = this.syncOnce().finally(() => (this.syncing = null)));
    // The running sync may have read Google before what its caller wants to see, so everyone who asks meanwhile shares one more after it.
    return (this.again ??= this.syncing
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.again = null;
        return this.sync();
      }));
  }

  private async syncOnce(): Promise<SourceState> {
    const source = this.calendarSource;
    const adapter = this.adapters[source];
    if (!adapter?.sync || !this.syncs) return this.sourceState(source, this.connected(source));
    await this.flush(source);
    try {
      const [{ since }] = this.db.all<{ since: number | null }>("SELECT max(revision) AS since FROM changes");
      await adapter.sync(this.syncIO(source, since ?? 0));
      // Edits still waiting keep saying why, so the source doesn't look fine while they wait.
      const waiting = this.db.all<{ error: string | null }>("SELECT error FROM outbox WHERE source = ? ORDER BY seq LIMIT 1", source)[0];
      this.setState(source, { lastSync: this.now(), error: waiting?.error ?? undefined, reconnect: false });
    } catch (err) {
      this.setState(source, err instanceof ReconnectNeeded ? { reconnect: true } : { error: (err as Error).message });
    }
    return this.sourceState(source, this.connected(source));
  }

  private connected(source: SourceId): boolean {
    return source !== "google" || !!this.connectedToken();
  }

  /** Whether the calendar source has a sync to run: one with something behind it, connected. */
  get syncs(): boolean {
    const source = this.calendarSource;
    return !!this.adapters[source]?.sync && (source !== "google" || !!this.connectedToken());
  }

  /** Whether the calendar source should sync now: it syncs, and hasn't within `ms`. */
  due(ms: number): boolean {
    if (!this.syncs) return false;
    const st = this.state(this.calendarSource);
    return !st.reconnect && (st.lastSync ?? 0) + ms <= this.now();
  }

  /**
   * What a sync writes through. A record with an edit waiting to go out is left as it is: pushing the
   * edit merges it with Google's version. One changed here since the sync began, or whose edit is
   * being pushed now, is left too, since its page may be older or newer than that change; the next
   * sync reads it again by id.
   */
  private syncIO(source: SourceId, since: Revision): SyncIO {
    const author = SYNC_AUTHOR[source];
    const left = new Map<string, Set<string>>();
    const leave = (path: FilePath) => {
      const key = keyOfPath(path);
      if (key) left.set(key.collection, (left.get(key.collection) ?? new Set()).add(key.id));
    };
    const pending = (path: FilePath) => {
      if (this.db.all("SELECT 1 FROM outbox WHERE path = ?", path).length) {
        if (path === this.pushing) leave(path);
        return true;
      }
      const changed = this.db.all(
        "SELECT 1 FROM changes WHERE path = ? AND revision > ? AND NOT (json_extract(author, '$.kind') = 'sync' AND json_extract(author, '$.source') = ?) LIMIT 1",
        path,
        since,
        author.source,
      ).length;
      if (changed) leave(path);
      return changed > 0;
    };
    const write = (path: FilePath, text: string | null) => {
      const current = this.files.read(path);
      if (text === null) {
        if (current) this.files.write({ path, text: "", base: current.revision, author, delete: true });
        this.db.run("DELETE FROM etags WHERE path = ?", path);
      } else if (current?.text !== text) this.files.write({ path, text, base: current?.revision ?? 0, author });
    };
    const eventPath = (calendar: string, id: string) => recordPath({ source, kind: "event", collection: calendar, id });
    const dropEvent = (path: FilePath) => {
      if (!pending(path)) write(path, null);
    };
    return {
      calendars: (list) => {
        const keep = new Set(list.map((c) => c.id));
        for (const c of list) write(recordPath({ source, kind: "calendar", collection: "", id: c.id }), recordText(c));
        for (const path of this.records.all(source, "calendar")) {
          const id = keyOfPath(path)?.id;
          if (!id || keep.has(id)) continue;
          for (const p of this.records.inCalendar(source, id)) dropEvent(p);
          write(path, null);
          this.setToken(source, id, null);
          this.setRecheck(source, id, []);
        }
      },
      token: (calendar) => this.state(source).tokens?.[calendar] ?? null,
      setToken: (calendar, token) => {
        this.setToken(source, calendar, token);
        this.setRecheck(source, calendar, [...(left.get(calendar) ?? [])]);
      },
      recheck: (calendar) => this.state(source).recheck?.[calendar] ?? [],
      put: (event, etag) => {
        const path = eventPath(event.calendar, event.id);
        if (pending(path)) return;
        write(path, recordText(event));
        if (etag) this.setEtag(path, etag);
      },
      remove: (calendar, id) => {
        dropEvent(eventPath(calendar, id));
        for (const p of this.records.family(source, calendar, [id])) if (keyOfPath(p)?.id !== id) dropEvent(p);
      },
      prune: (calendar, keep) => {
        for (const p of this.records.inCalendar(source, calendar)) if (!keep.has(keyOfPath(p)?.id ?? "")) dropEvent(p);
      },
    };
  }

  private setRecheck(source: SourceId, calendar: string, ids: string[]) {
    const recheck = { ...this.state(source).recheck };
    if (ids.length) recheck[calendar] = ids;
    else delete recheck[calendar];
    this.setState(source, { recheck });
  }

  private setToken(source: SourceId, calendar: string, token: string | null) {
    const tokens = { ...this.state(source).tokens };
    if (token) tokens[calendar] = token;
    else delete tokens[calendar];
    this.setState(source, { tokens });
  }

  /** A source's queued edits, oldest first: what's waiting, and why. */
  outbox(source: SourceId): Array<{ path: string; op: "put" | "delete"; author: string; time: number; attempts: number; error: string | null }> {
    return this.db
      .all<{ path: string; op: string; author: string; time: number; attempts: number; error: string | null }>("SELECT path, op, author, time, attempts, error FROM outbox WHERE source = ? ORDER BY seq", source)
      .map((r) => ({ ...r, op: (JSON.parse(r.op) as RecordOp).op }));
  }

  /**
   * Put a record back to a text it had (or delete it, for ""), as an edit of its source: how undo
   * and restore reach records, so the source hears of it too. A changed occurrence with no text to go
   * back to goes back to how its series makes it, its series as `undoing` will leave it: the texts
   * other records of the same undo go back to.
   */
  async revert(path: FilePath, text: string, author: Author, undoes?: Revision, undoing: ReadonlyMap<string, string> = new Map()): Promise<EditResult | Refused> {
    const key = keyOfPath(path);
    if (!key || key.kind !== "event") return { status: "refused", error: `${path} changes only through its source's sync` };
    const before = readEvent(this.files.read(path)?.text ?? "");
    const after = text ? readEvent(text) : null;
    if (text && !after) return { status: "refused", error: `That version of ${path} isn't an event` };
    const family = this.family(key.source, key.collection, key.id).flatMap((e) => {
      const going = undoing.get(recordPath({ source: key.source, kind: "event", collection: e.calendar, id: e.id }));
      const event = going === undefined ? e : readEvent(going);
      return event ? [event] : [];
    });
    const ops = planRevert(family, before, after);
    return this.apply(key.source, ops, author, addressOf(key), undoes);
  }
}

/**
 * A workspace's files and data sources on its database: files tell the records index what they
 * write, and record files written before the index existed are indexed once.
 */
export function openWorkspace(db: Db, settings: SourceSettings, announce?: (notice: ChangeNotice) => void, fetcher?: typeof fetch, adapters: Adapter[] = [], now: () => number = Date.now): { files: Files; sources: DataSources } {
  const records = new Records(db);
  const files = new Files(db, Date.now, announce, (path, text) => records.observe(path, text));
  if (!records.counts().length) records.rebuild(files.under(RECORDS_DIR));
  return { files, sources: new DataSources(db, files, records, settings, fetcher, now, adapters) };
}

/** A record file's calendar, or null if its text isn't one. */
export function readCalendar(text: string): Calendar | null {
  try {
    const c = JSON.parse(text) as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.title !== "string") return null;
    return {
      id: c.id,
      title: c.title,
      color: typeof c.color === "string" && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#4f6bd8",
      ...(c.primary === true ? { primary: true } : {}),
      writable: c.writable !== false,
      ...(typeof c.timeZone === "string" ? { timeZone: c.timeZone } : {}),
      ...(c.selected === false ? { selected: false as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Undo changes: files the usual way, and records through their data source, so the source hears of
 * it. A record's change is undone by putting the record back as it was just before, and only if
 * nothing has changed it since; otherwise it's a conflict, as an undo that clashes in a note is.
 */
export async function undoChanges(files: Files, sources: DataSources, revisions: Revision[], author: Author): Promise<UndoResult[]> {
  const change = (r: Revision) => files.recent({ before: r + 1, limit: 1 }).find((c) => c.revision === r);
  const isRecord = (r: Revision) => isRecordPath(change(r)?.path ?? "");
  const plain = revisions.filter((r) => !isRecord(r));
  const out: UndoResult[] = plain.length ? files.undo(plain, author) : [];
  // What each record goes back to, worked out first, so a changed occurrence is judged against its series as this undo leaves it, whatever order they go in.
  const reverts = [...new Set(revisions.filter(isRecord))]
    .sort((a, b) => b - a)
    .map((r) => {
      const { path } = change(r)!;
      if (files.recent({ path, limit: 1 })[0]?.revision !== r) return { r, path, text: null };
      const previous = files.recent({ path, before: r, limit: 1 })[0];
      return { r, path, text: previous ? (files.versionAt(path, previous.revision) ?? "") : "" };
    });
  const undoing = new Map(reverts.flatMap(({ path, text }) => (text === null ? [] : [[path, text] as const])));
  for (const { r, path, text } of reverts) {
    if (text === null) {
      const file = files.read(path);
      out.push({ revision: r, status: "conflict", ...(file ? { file } : {}) });
      continue;
    }
    const result = await sources.revert(path, text, author, r, undoing);
    const file = files.read(path);
    out.push({ revision: r, status: result.status === "refused" ? "conflict" : "undone", ...(file ? { file } : {}) });
  }
  return out;
}

/** Put a file back as it was at a revision (or just before one); a record goes back through its data source. */
export async function restoreFile(files: Files, sources: DataSources, path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author): Promise<WriteResult | null> {
  if (!isRecordPath(path)) return files.restore(path, at, author);
  const revision = "revision" in at ? at.revision : (files.recent({ path, before: at.before, limit: 1 })[0]?.revision ?? 0);
  const text = files.versionAt(path, revision);
  if (text === null) return null;
  const result = await sources.revert(path, text, author);
  const file = files.read(path);
  if (result.status === "refused") return { status: "conflict", file };
  return { status: "saved", file: file ?? { path, text: "", revision } };
}

/** Times as agents and the app send them: days, or wall times with an optional zone. A day alone means all day. */
export function timingFrom(raw: Record<string, unknown>): EventTiming | string {
  const allDay = raw.allDay === true || (raw.allDay !== false && typeof raw.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.start));
  return parseTiming({ ...raw, allDay });
}
