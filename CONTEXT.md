# Common Ink

A hosted workspace where a person and their agents read and edit markdown notes, tasks and data from outside sources, with every change visible and attributed.

## Content

**Workspace**:
The top-level container a user signs in to. It holds notes, uploads, settings and connected data sources.
_Avoid_: Vault, project

**File**:
Anything stored in a workspace, addressed by its path. Notes are markdown files; settings and layout are JSON files.
_Avoid_: Doc, document, asset

**Note**:
A markdown file in a workspace. Its title is its first `#` heading.
_Avoid_: Document, page

**Task**:
A markdown checkbox line in a note, with optional inline tokens (due:, rec:, …).
_Avoid_: Todo, item

**Data source**:
External structured data connected to a workspace, such as calendar events or contacts. Its contents are visible but aren't stored as notes.
_Avoid_: Integration, connector

**Record**:
One item a data source brings into the workspace, such as an event or a calendar. It has history like a file, but changes only through its data source.
_Avoid_: Item, entry, object

**Sample calendar**:
The data source that stands in for Google in Previews and local development, with nothing behind it.

**Event**:
A calendar entry that comes from a data source and may recur.

**Series**:
An event that repeats. It's one record; its occurrences are worked out from its rule.
_Avoid_: Recurring event (in code), master

**Occurrence**:
One time an event happens. An occurrence of a series that was changed or cancelled on its own is a record of its own.
_Avoid_: Instance, exception (in the UI)

**Sync**:
Bringing a data source's own changes into the workspace. Its changes have the sync as their author.

**Upload**:
A binary file (image, PDF, …) attached to a workspace and referenced from notes by its address, `/uploads/<name>`. Uploading is a change to `.common-ink/uploads.json`.
_Avoid_: Asset, attachment

**Media session**:
Something that plays: background noise, or a video or track in a note's link embed. The mini player, the status bar and the media keys control the one played last. A playing video floats in a small window while its note is out of sight, and docks when the note shows again.
_Avoid_: Player (that's the site's own, in the frame), picture-in-picture

## History

**Change**:
One recorded edit to the workspace, with its author, a diff and the revision it was based on.
_Avoid_: Commit, event, op

**Author**:
Who made a change: the user, a named agent, an extension, sync, or Trash retention (which purges notes that have been in Trash too long).

**Label**:
A name given to a note's state at one revision, so it can be found, opened and restored later.
_Avoid_: Tag, snapshot, bookmark

**History**:
The ordered record of every change in a workspace. Undo and redo move through it.
_Avoid_: Log, timeline, versions

## Configuration

**Settings**:
JSON that configures behavior, at either user or workspace level. Workspace settings override user settings.
_Avoid_: Preferences, config

**Extension**:
A unit of functionality that adds commands, views, settings, embeds and more through the public extension API, declared in its `extension.json`. Built-in features are extensions. A workspace extension is a folder of files in the workspace (`.common-ink/extensions/<id>/`), and one with a built-in's id runs in its place: that's a customized built-in.
_Avoid_: Plugin, add-on

**Default extension**:
A built-in extension that's on until you turn it off, such as Workbench, Vim, Live preview or Tasks. With all of them off, the app still has notes, history, plain windows, commands and settings, and a plain editor.

**Catalog**:
The list of extensions you can install from the Extensions view: first-party ones that aren't on by default, served by the app, and any other catalogs you add, whose extensions are other people's and installed at your own risk.

**Contribution**:
Something an extension's manifest declares it adds: a command, keybinding, menu item, settings section, view, status bar item or embed. The app shows contributions before the extension's code runs.

**Activation event**:
What starts an extension's code: the app starting, or one of its commands running, views showing or embeds drawing for the first time.

**Permission**:
Something an extension may ask to do beyond running and drawing, such as reaching a host or reading notes. Its manifest declares the most it can ask for, with why; you're asked the first time it's used, and your answer is kept in settings.

**Trusted extension**:
One that runs in the app's page, with access to note editors: the built-ins, and any you mark trusted. Every other extension runs sandboxed.

**Safe mode**:
The app with only built-in extensions running, for when a workspace extension breaks it. Open the app with `?safe=1`.

## Navigation

**Query**:
Text that says which notes a list shows and in what order, such as `launch in:Projects/ -is:archived sort:edited`: words and "phrases" to find, and filters (`is:`, `in:`, `from:`, `type:`, `edited:`, `has:`, `sort:`), any of them negated with `-`. One language serves search, the Feed and saved searches, in the app, over MCP and in the CLI.
_Avoid_: Filter (that's one part of a query), search string

**Archive**:
A state a note can be in: kept, out of the Feed, shown last in search, still in place and still linked. Its path is listed in `.common-ink/archive.json`; archiving doesn't move or change the note.
_Avoid_: Hide, move to archive

**Trash**:
The notes deleted in the last `trash.retentionDays` days (30 by default), whatever is at their paths now. It's a view over history, not a folder: restoring a note undoes its delete, so it comes back where it was with its history, or beside the note that has its path now.
_Avoid_: Bin, recycle

**Note** (in history):
Which changes are one note's, decided as each is written: a change to a file is its note's; one that brings a deleted note back (Restore, beside a new note too) carries that note on; any other that makes a file starts a note. A note is a file at one path at a time.
_Avoid_: Lifetime (worked out from history afterwards, which a purge can change)

**Purge**:
Removing a deleted note's text from history, every change of that note at every path it had, after its time in Trash or on Delete forever. Only the person can purge, never an agent, and each purge leaves a change saying who purged what and when.
_Avoid_: Hard delete, permanent delete (in code)
