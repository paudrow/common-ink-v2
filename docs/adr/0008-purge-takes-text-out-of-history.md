# Purging takes a deleted note's text out of history

ADR 0002 makes history the source of truth: nothing is lost, and every change can be undone. Trash builds on that, since a deleted note is a delete change that restoring undoes. But sometimes a note must really be gone: a password pasted by mistake, or a note kept past the time anyone wants it. So one change is allowed to remove history: a **purge**.

Purging a deleted note removes every change to that path from history, with the ids of edits to it, and writes one change in their place. That change has no text and no diff, can't be undone, and says who purged the note and when. History is per file, and no other file's changes refer to this one's, so every other file's history replays exactly as before. A property test checks that, with purges at any point.

- **Only deleted notes.** A note that's there can't be purged. Delete it first, so it passes through Trash.
- **Only a person.** Purge is an operation of the app's, not offered over MCP, and refused for agents and extensions, whatever route they use. The app asks first, for one note (Delete forever) or all of them (Empty Trash).
- **Or Trash retention.** Once a day the workspace's Durable Object purges notes deleted more than `trash.retentionDays` days ago (30 by default). Those changes are by Trash retention, so History says so.
- **The search index forgets at once.** FTS5's secure-delete is on, so a note's words leave the index when it's deleted, not at some later merge.

## Consequences

- Undo can't reach a purge, and Restore can't bring a purged note back. That's the point.
- Labels and other workspace JSON that name a purged path keep the name. The text they pointed to is gone, so a label's version can't be opened.
- SQLite may keep freed pages' old bytes in its file until they're reused. Purge doesn't promise more than the database does.
