# Purging takes a deleted note's text out of history

ADR 0002 makes history the source of truth: nothing is lost, and every change can be undone. Trash builds on that, since a deleted note is a delete change that restoring undoes. But sometimes a note must really be gone: a password pasted by mistake, or a note kept past the time anyone wants it. So one change is allowed to remove history: a **purge**.

A purge takes one note in Trash, named by its delete. It removes the changes that made up that note, from the delete before it at its path up to this one, and writes one change in their place. That change has no text and no diff, can't be undone, and says who purged the note and when. A delete that Restore took back at its own path doesn't end a note, so a note restored and deleted again is purged whole. History is per file, and no other file's changes refer to this note's, so every other file's history replays exactly as before, and so does a note made at the same path since (a daily note, Untitled N). A property test checks that, with purges at any point, against a model of which note each change belongs to.

- **Only notes in Trash.** A note that's there can't be purged. Delete it first, so it passes through Trash.
- **Only a person.** Purge is an operation of the app's, not offered over MCP, and refused for agents and extensions, whatever route they use. The app asks first, for one note (Delete forever) or all of them (Empty Trash). An empty agent header counts as an agent, never as the person.
- **Or Trash retention.** Once a day the workspace's Durable Object purges notes deleted more than `trash.retentionDays` days ago (30 by default). Those changes are by Trash retention, so History says so. Only a person may change `trash.retentionDays`, and retention uses the value a person last set, whatever wrote the settings file since, so no agent can make Trash retention purge sooner.
- **Edits can't bring it back.** The ids of edits to a purged note stay, with their text's hash taken out, so a page that never heard an answer and sends an edit again is refused. A write based on a purged revision can't be merged, so it's refused too.
- **The search index forgets.** The index is merged after a purge, so none of the note's words stay in its blocks.
- **Browsers forget.** A page that hears of a purge drops the note's kept copy, its draft and any edit held for it, and closes it where it's open. A page's kept copies of files the workspace no longer lists go when it next lists them.

## Consequences

- Undo can't reach a purge, and Restore can't bring a purged note back. That's the point.
- Labels and other workspace JSON that name a purged path keep the name. The text they pointed to is gone, so a label's version can't be opened.
- Purge doesn't promise more than storage does. SQLite may keep freed pages' old bytes in the database file until they're reused, and Durable Objects' point-in-time recovery keeps the database as it was, purged text included, for up to 30 days.
- Uploads that only the purged note used stay: their bytes in R2 and their entries in `.common-ink/uploads.json`. Purging uploads too is follow-up work.
