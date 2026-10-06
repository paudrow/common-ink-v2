# Data sources

Calendar events, and later contacts, come from outside the workspace: Google is where they live, and Common Ink shows them, changes them and links notes to them. They're **records** of a **data source**, kept apart from notes but just as observable. A record is a JSON file under `.common-ink/records/`, so every change to it is a change in history with an author, a diff and undo. It changes only through its data source, which writes it as the person's (or agent's) change and sends it on to Google. What changes in Google comes back through sync, as changes by the sync.

## A record is a file with an index beside it

The brief was a typed `records` table (source, kind, id, JSON, etag, time, revision) next to the files. We kept the typed table, as an index, and put the JSON in files, because everything ADR 0002 gives files then comes free: history, diffs, filtered undo, restore, labels, the live socket's notices, the History view, the CLI's `history` and `show`, and seeds. A second table holding JSON would have needed its own history, its own diffs and its own undo, which is the duplication ADR 0002 exists to prevent.

- **Paths.** `.common-ink/records/<source>/events/<calendar>/<id>.json` and `.common-ink/records/<source>/calendars/<id>.json` (`worker/src/records.ts`). The JSON is the event as Common Ink models it (`worker/src/calendar.ts`), with its keys in one order so a diff shows only what changed.
- **Apart from notes.** The file list leaves records out, so quick open, links and offline warming never see them. A record opens read-only. `write_file` and `delete_file` refuse a record's path and say which operation changes it.
- **The index.** The `records` table holds each event's source, calendar, id, rough start and end, and whether it's a series. `Files` tells it of every write in the same transaction, so it can't disagree with the files, and `rebuild` makes the same index from the files again. Version tags from the source (Google's etags) sit in their own table: they're sync's bookkeeping, not part of the event.
- **Undo and restore go through the source.** Undoing a change to a record puts the record back as it was just before, as an edit of the data source, so Google hears of it too. If the record changed since, it's a conflict, as an undo that clashes in a note is.

## Edits are written here first, then sent

An edit (from the app, an agent or the CLI) is planned as the records it writes, then written as one transaction: the record files, as the author's changes, and an entry per record in the **outbox**. Then the source's **adapter** pushes the outbox in order. The Sample calendar's adapter takes everything at once; Google's pushes to the Calendar API with the record's etag. A push that fails for now (Google is down, too many requests, sign-in) stays in the outbox with its error, and later ones wait behind it, since they may build on it. One Google refuses (a 4xx: an invalid field, a rule of the calendar's) would never go, so it's dropped with the record's later edits, the record goes back to how it was, and the Data sources view and whoever made the edit hear why; history keeps the edit. Pushes take turns, so none goes out twice. So an edit is never lost: if Google refuses our sign-in (a test app's refresh token ends after 7 days), the edit is in the workspace and history, the source says it needs reconnecting, and the outbox goes out once you reconnect. Pushing again after a crash writes the same record, so it's safe.

Adapters run in the Worker, next to the Durable Object that holds the refresh token, which never reaches a page. `Adapter` (`worker/src/adapter.ts`) is the seam another source plugs into: push one record's change, and sync.

When Google changed an event while our edit of it waited, the push's etag no longer matches and Google answers 412. The edit, and every edit of that record queued after it, is then merged onto Google's version field by field, each from what it started from: each field takes the side that changed it, and where both changed the same field, Google's wins. The Data sources view says so, and the record's history still has ours. Pushes are PATCHes of the fields Common Ink models, so guests, reminders and video calls stay as Google has them.

## Sync brings Google's changes back as changes by the sync

Sync is incremental: one Google `syncToken` per calendar, a full sync again when Google answers 410 Gone, and the calendar list each time. A sync leaves an event as it is here when someone changed it here while the sync ran, or its edit was going to Google just then, since the page it came on may be older or newer than that change. It keeps the ids of those events with the source, and the next sync reads each of them from Google again before the calendar's changes. It runs on a Durable Object alarm, and when a calendar view opens; `syncToken` and the alarm are kept with the source, never in a file. Each record it changes is a change by `sync:google-calendar`, so History can show only what came from Google, or everything but. Push notifications (watch channels) can come later without changing any of this. The Google adapter is `worker/src/google-calendar.ts`, tested end to end against a fake Calendar API (`worker/src/fake-google.ts`) that has sync tokens, pages, etags, recurring events, 410 Gone and invalid_grant.

## A series is one record

A repeating event is one record with its RRULE, EXDATE and RDATE lines, as Google keeps it. Its occurrences are worked out for the days asked for (`occurrences` in `worker/src/calendar.ts`, with the repeat rules tasks use, now the `common-ink/recurrence` library), so a series that never ends costs one record. An occurrence changed or cancelled on its own is a record of its own, with its series and the start it replaces, and its id is Google's: the series' id, `_`, and the original start (`standup_20261007T160000Z`).

Editing an occurrence asks which, as Google does. "This event" writes that occurrence's own record. "This and following" ends the series just before it (shortening COUNT, or setting UNTIL) and starts a new series there with the change. "All events" changes the series, moving every occurrence by as much as this one moved, its weekdays with it. Occurrences changed on their own keep their changes either way: they go where their original start goes, in the new series after a split, and their days skipped go too. Only what an edit changes counts, so saving a series with its times as they were moves nothing. `planUpdate` and `planDelete` turn each choice into the records it writes, so the Sample calendar and Google do the same thing.

Taking back an occurrence's own change (undo, or restoring it to before it was changed) writes the occurrence as its series makes it, with `planRevert`, rather than deleting its record: Google cancels an occurrence whose instance is deleted, and has no way to make an instance plain again. So the occurrence stays a record of its own, here and in Google, with its series' title and times as they were then. A later edit of the whole series leaves it as it is, as it leaves every occurrence changed on its own. Google's [guide to recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents) doesn't say whether an edit of a series reaches the occurrences changed on their own, so this is how Common Ink keeps them, not a rule of Google's. An undo judges each occurrence against its series as the whole undo leaves it. A series that goes back takes with it the occurrences that are only its own written out at starts it won't have any more. So undoing an edit's changes together, or one at a time in any order, ends the same.

## Times are wall times in a zone

An event's start and end are wall times ("2026-10-05T09:00") with an IANA time zone, or days for an all-day event, whose end is the day after its last. An event without a zone floats: it happens at that wall time wherever it's seen from, as all-day events do. Google's events all have zones; the Sample calendar's float, so a Preview shows them at their times in anyone's zone and with any clock lever. Occurrence ids of a floating series are written as wall times, so they're the same from anywhere.

## Notes link to events with a markdown link

A note links to an event with `[Team standup](event:google/primary/standup_20261007T160000Z)`. We chose a markdown link over a wiki link (`[[event:…]]`) because it stays readable anywhere markdown is: the text is the event's name when it was linked, and the address says where it lives. Live preview draws it as a chip with the event's time and title as they are now, and an event lists the notes that link to it; both come with the calendar links pull request. The address is `event:<source>/<calendar>/<id>`, each part percent-encoded if it needs to be. "Create meeting note" makes a note with that link; writing a link back into the Google event's description is a setting, off by default, since it changes your calendar for everyone invited.

## Extensions reach records through the broker

Data sources are declared in a manifest (`contributes.dataSources`: an id, a kind, a title), and the extension draws their views and embeds; the sync behind them is the Worker's. Code reaches records only through `ctx.data`, checked against new permission kinds, said plainly in prompts: `data:calendar:read` ("see your calendar's events"), `data:calendar:write` ("add, change and delete events in your calendar") and `data:contacts:read`. They replace ADR 0006's `calendar:read` and `contacts:read`. A built-in changes records as you; any other extension as itself, acting for you, as its file writes are.

## Previews and development have a Sample calendar

Previews, `npm run dev` and the browser tests have no Google. The **Sample calendar** is a data source with nothing behind it: its records are seeded per scenario (`examples/preview/data-sources/`, the `calendar` scenario), dated from the scenario's clock, and edits, recurrence, history and undo work on it as they do on Google. Contacts there still come from recorded fixtures.

## Considered options

- **Records in a table of their own, with their own history.** Rejected: see above.
- **Events as notes (one markdown file per event).** Rejected: an event's fields aren't prose, Google owns them, and every note feature (search, links, tasks) would trip over thousands of them.
- **Expanding recurring events in Google (`singleEvents=true`).** Rejected: a series that never ends has no last occurrence to stop at, and sync tokens work per event either way. Keeping the series is also what makes "this and following" exact.
- **Each sync change as one history change for the whole sync.** Rejected for now: history is per file, and a change per record is what lets you see, filter and undo one event's history. A first sync of a big calendar is many changes by the sync; History's filter by author is the answer.

## Consequences

- History holds sync's changes too. They're by `sync:google-calendar`, so they're easy to leave out.
- An edit made offline in the app needs a queue in the page as well, since the Worker's outbox only starts once the edit reaches it. The calendar view's pull request adds it, next to the offline queue for notes (ADR 0001).
- Contacts become records the same way when they're editable: `kind: "contact"`, `contact:<source>/<id>` addresses, and `data:contacts:write`.
