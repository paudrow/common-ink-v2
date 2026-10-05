# Common Ink

A hosted workspace where a person and their agents read and edit markdown notes, todos and data from outside sources, with every change visible and attributed.

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

**Todo**:
A markdown checkbox line in a note, with optional inline due date and recurrence.
_Avoid_: Task, item

**Data source**:
External structured data connected to a workspace, such as calendar events or contacts. Its contents are visible but aren't stored as notes.
_Avoid_: Integration, connector

**Event**:
A calendar entry that comes from a data source and may recur.

**Upload**:
A binary file (image, PDF, …) attached to a workspace and referenced from notes by its address, `/uploads/<name>`. Uploading is a change to `.common-ink/uploads.json`.
_Avoid_: Asset, attachment

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
