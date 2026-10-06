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
Who made a change: the user, a named agent, an extension or sync.

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

**Place**:
Somewhere you can go in the app: the Feed, Today, Tasks, Calendar, a pinned note, a saved search, Sources, Archive, Trash, Extensions or Settings. Places are a sheet on a phone and a sidebar on a wide screen.
_Avoid_: Activity, section, tab (a tab holds an open window)

**Device**:
One browser or app a person uses Common Ink on, with its own file of settings, overrides and layout. What it has (width, touch, a keyboard) decides which extensions and contributions apply.

**Requirement**:
What an extension or contribution needs from a device to work, such as a keyboard or a wide screen, declared as `requires`. One that isn't met is off on that device, with the reason shown, unless you turn it on there.
_Avoid_: Platform, desktop-only, mobile-only
