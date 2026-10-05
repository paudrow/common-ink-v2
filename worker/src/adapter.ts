// How a data source's records reach it and come back (ADR 0007): the seam an adapter plugs into.
// Built-in adapters (the Sample calendar, Google Calendar) run in the Worker.
import type { Calendar, CalendarEvent, RecordOp } from "./calendar.ts";
import type { SourceId } from "./records.ts";

/** An adapter couldn't push or sync because the source wants you to sign in again. */
export class ReconnectNeeded extends Error {}

/** The source won't take a change as it is (an invalid field, a rule of the calendar's), so sending it again won't help. */
export class Refusal extends Error {}

/** What a source says about one pushed edit. */
export interface Pushed {
  /** The source's version tag for the record, for its next edit. */
  etag?: string;
}

/** How a source's records reach it and come back. Built-in adapters run in the Worker; this is the seam for others. */
export interface Adapter {
  source: SourceId;
  title: string;
  /** Send one record's change to the source. Throws ReconnectNeeded, a Conflict, a Refusal, or any other error to keep it queued. */
  push(op: RecordOp, etag: string | null, calendar?: Calendar): Promise<Pushed>;
  /** Bring the source's own changes in, through `io`. A source with nothing behind it has none. */
  sync?(io: SyncIO): Promise<void>;
}

/** What a sync writes through: records as changes by the sync, and its tokens, kept with the source. */
export interface SyncIO {
  /** Every calendar the source has now; ones it no longer has go, with their events. */
  calendars(list: Calendar[]): void;
  token(calendar: string): string | null;
  setToken(calendar: string, token: string | null): void;
  /** An event as the source has it. One with an edit here waiting to go out is left as it is. */
  put(event: CalendarEvent, etag: string | null): void;
  remove(calendar: string, id: string): void;
  /** After a full sync: the calendar's other events are gone from the source. */
  prune(calendar: string, keep: ReadonlySet<string>): void;
}

/** The source changed the record since we last saw it: here's how it is there now, with its version tag. */
export class Conflict extends Error {
  constructor(readonly remote: CalendarEvent | null, readonly etag: string | null) {
    super("The source has a newer version of this event");
  }
}

