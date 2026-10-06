# Navigation study: places, a feed, archive, trash and search

A UX research study for Common Ink v2: how to organize extensions' views and side panels, a scrollable feed of notes you can triage, archive, a 30-day trash, data sources and search. It ends with a recommendation, prototypes, a build plan and the decisions only you can make.

- **Status:** a proposal. No app code changes.
- **Prototypes:** [navigation-places.html](prototypes/navigation-places.html) (recommended) and [navigation-workbench.html](prototypes/navigation-workbench.html) (alternative). Open them in a browser straight from the repo; they need nothing else. Press `?` in either for every key, and the "⚙ prototype" button in the status bar for theme and settings.
- **Method:** reading the v2 docs, ADRs and code; running v2 locally (`calendar` scenario) to see the UI as it is; reading Common Ink v1's README for what it already shipped; and a comparative review of 20 apps from their own documentation (sources at the end).

## Contents

1. [The short version](#1-the-short-version)
2. [Where v2 is today](#2-where-v2-is-today)
3. [What v1 taught us](#3-what-v1-taught-us)
4. [Comparative analysis](#4-comparative-analysis)
5. [Answers to the study's questions](#5-answers-to-the-studys-questions)
6. [Three navigation models](#6-three-navigation-models)
7. [Recommended model: Places and the Feed](#7-recommended-model-places-and-the-feed)
8. [Build plan](#8-build-plan)
9. [Testing with you](#9-testing-with-you)
10. [Decisions for you](#10-decisions-for-you)
11. [Sources](#11-sources)

## 1. The short version

**Recommendation: Places and the Feed.** A quiet text sidebar called **Places** replaces today's flat notes list. It holds the Feed, Search, the places extensions add (Today, Tasks, Calendar), your pinned notes and saved searches, and at the bottom Sources, Archive, Trash, Extensions and Settings. A place opens as a tab in the editor area, so it can sit in a split next to a note. The right-hand side panel becomes the **context panel**: views about the note in focus (History, Links, Agenda, an extension's view), one at a time, with a switcher. There is no icon-only activity bar and no bottom panel to start with.

**The Feed is the home place.** It's the notes you and your agents changed, newest first, as cards with a live preview, and keyboard triage in Gmail's and Superhuman's keys: `j`/`k`, `↵` open, `o` open beside (the reading pane follows `j`/`k`), `e` archive, `#` or `dd` trash, `p` pin, `x` select, `u` undo. Agents' changes say who made them, with a purple dot for ones you haven't seen, and an Agents filter.

**One idea runs through it: every list of notes is a query.** The Feed is `-is:archived sort:edited`. Archive is `is:archived`. A saved search (v1's smart folder) is a query you named. Search results open as a tab of the same cards. One parser, shared by the search bar, the Feed's filter, saved searches, MCP and the CLI.

**Archive is a state, kept in a file. Trash is history.** Archiving adds the note's path to `.common-ink/archive.json`, so the note stays where it is, links and history are untouched, and that file's history is the archive log. Deleting already exists as a change in history; Trash is a view of the delete changes from the last 30 days, Restore is undoing that change, and after 30 days the note is **purged**: its text leaves history too. Nothing new is invented for Trash, and nothing about it is hidden.

**Search is one bar** (`⌘K`, and `⌘P` as today) across notes, tasks, events, contacts, commands and settings, with Gmail-style filters (`is:archived`, `in:Projects/`, `from:agent`, `type:event`, `edited:<7d`) that Tab completes, `⌘↵` to open all results as a tab, and an action menu on any result (Raycast's idea) to archive, pin or open beside without leaving the bar.

The alternative most worth comparing is a **VS Code-style Workbench**: an activity bar of icons, a side bar of collapsible views (Pinned, Recent, Archive, Trash), and a bottom panel for agent activity. It's familiar and scales to many extensions, but it's heavier, and its feed is a list of titles rather than something you read.

## 2. Where v2 is today

Seen by running `npm run dev -- --scenario calendar` and reading `web/src/`:

- **Left:** a flat list of every note by title (`#notes` in `main.ts`), with no folders, counts or sections. Clicking opens the note in the focused window, as a preview tab.
- **Centre:** the Workbench extension's windows, tabs and splits (`layout.json`).
- **Right:** one side panel (`panels.ts`) showing one view at a time with a title and a close button. History, Calendar, Tasks, Contacts, Uploads and Data sources all declare `views.sidebar` and land here. Any panel can also open as a tab.
- **Status bar:** Vim's mode and save state on the left, the clock on the right.
- **Command bar:** `⌘P` opens notes by name (no full-text search yet); `⌘⇧P` lists commands; providers are chosen by prefix.
- **No archive, no pins, no trash view, no full-text search.** Deleting a note is a change with `deleted: true` (`worker/src/files.ts`), and undoing it brings the note back, but nothing lists deleted notes.
- **App state already lives in workspace JSON:** `layout.json`, `labels.json`, `settings.json`, `uploads.json`, and records under `.common-ink/records/`. ADR 0003 names pins and view state as things that go in workspace JSON, not frontmatter.
- **ADR 0006 already says** "The activity bar, sidebar and bottom panel arrive with the Workbench extension", and that "the activity bar waits for an extension that declares a view container; none does yet." This study is the design for that moment.

## 3. What v1 taught us

Common Ink v1 shipped most of what the request describes. From its README:

| v1 feature | What worked | What to change |
| --- | --- | --- |
| **Notes page**: every note as a card, newest first, rendered preview; Active / Archived / All; `j`/`k`, `↵`, `e` archive, `x` select, `/` filter | The card feed and its keys. This is the Feed. | It was one page among many; make it home. Add who changed it, for agents. |
| **Archive** moved a note to `Archive/<original path>`, out of the sidebar, search, `@` suggestions and agents' default listings; links kept working; Undo | One key, reversible, out of the way. | Moving the file changes its path, so history, links and labels must follow a rename. v2 has no rename yet. A state in JSON keeps the path. |
| **Trash**: 30 days, then gone; restore where it was; Delete forever and Empty trash ask first; agents can't delete for good; deleting forever took the note's text out of the change log | All of it. Keep it word for word. | v1 kept trashed files in a hidden `.trash/` folder. In v2, history already holds the deleted text, so Trash needs no folder. |
| **Sidebar led with tags**: views (Notes, Tasks, Assets, History), Favorites, Smart folders, Folders, Tags | Favorites and smart folders at the top earned their place. | It grew long and busy; the top bar and status bar got crowded too (your note on #135). Keep Places to one short list. |
| **Smart folders**: saved `::query` filters with live counts, one parser and engine shared with the Notes filter and `::query` | One query language everywhere. | Same idea, now also covering archive, trash, authors and data sources. |
| **Stars** on notes and tags, per person, by stable ID | Pinning what you reach for. | Call it pin (v2 already says "pins" in ADR 0003). |
| **Search**: `⌘P` quick open with FTS5 full text; `>` for commands | One bar. | Add filters, events, contacts, settings, and actions on results. |

## 4. Comparative analysis

Each app: the patterns that matter here, what works, and what doesn't. Sources are in [section 11](#11-sources).

### 4.1 Navigation and panels

**VS Code.** An activity bar on the far left switches the primary side bar between view containers (Explorer, Search, Source Control…). A secondary side bar sits opposite, and a panel sits below the editor. Views can be dragged between the side bars and the panel, and a whole container can move from the activity bar to the panel; VS Code remembers the layout. The activity bar can move to the top or bottom, or hide. Extensions declare containers and views in `package.json` (`viewsContainers` for `activitybar` or `panel`, `views` with a `when` clause), so the layout is known before the extension runs. [1][2][3][4]
- *Works:* one model for every view; contributions are declarative; users rearrange by dragging and it sticks; keyboard toggles (`⌘B`, `⌥⌘B`, `⌘J`).
- *Doesn't:* icon-only activity bars need learning; views multiply into a busy chrome; drag-only rearranging is poor from the keyboard; the Explorer is a file tree, which is storage, not how you find notes.

**Obsidian.** A ribbon of action icons on the left that stays when the left sidebar collapses; left and right sidebars that hold plugin tabs (File explorer, Search, Backlinks, Outline) in tab groups that can split; the centre is tab groups that split either way. The Workspaces plugin saves and restores whole layouts. Ribbon icons can be reordered and hidden. [5][6]
- *Works:* context views (Backlinks, Outline) on the right about the note in focus; everything is a tab that can go anywhere.
- *Doesn't:* the ribbon is actions, not places, so it's another set of icons to learn; layouts get fiddly; plugins pile icons on.

**Zed.** Three docks (left, right, bottom); each panel (Project, Terminal, Agent, Debug) picks a dock in settings JSON or from its icon's menu, and each dock has a toggle action. [7][8]
- *Works:* where a panel lives is one setting in JSON, observable and editable. Very close to Common Ink's principles.
- *Doesn't:* panels are coarse; there's no per-view rearranging inside a dock.

**Linear.** A text sidebar: Inbox, My issues, then teams with their views, then favorites. `⌘K` runs any action by name; `G` then a letter goes places (`G I` Inbox); `J`/`K` move, single keys act on the selected issue; `/` and `F` filter; filters and views can be saved. [9][10][11]
- *Works:* text labels, not icons; "go" keys; every list is a filtered view you can save; keys act on the selection.
- *Doesn't:* single-letter keys need a list to have focus to be safe, which Linear handles by scope. (You don't like global single-letter keys; scope fixes it.)

**Arc.** A vertical sidebar of pinned and unpinned tabs per Space; unpinned tabs archive themselves after 12 hours (configurable up to 30 days) and go to an Archive you can search. [12][13]
- *Works:* auto-archive keeps the sidebar clean without a decision each time; pinned is the "keep" list.
- *Doesn't:* automatic archiving surprises people; Common Ink should archive only when asked (agents can suggest).

**Raycast.** One search bar (Root Search) is the home of everything: commands, files, apps, extensions' commands. Aliases and hotkeys go straight to a command; fallback commands take whatever you typed; an Action Panel (`⌘K`) lists what you can do with the selected result. [14][15][16]
- *Works:* actions on a result without leaving search; extensions add commands and results to one place.
- *Doesn't:* there's nothing to browse; it assumes you know what you want.

### 4.2 Feeds and triage

**X (Twitter).** A home timeline with two tabs (For you, Following), infinite scroll, and a "new posts" prompt at the top instead of jumping the list while you read. [17][18]
- *Works:* the feel you asked for: scroll, skim cards, keep your place; tabs for whose posts; new items wait to be pulled in.
- *Doesn't:* engagement ranking; no "done" state, so it never ends. A notes feed needs an end (archive) and must be chronological.

**Readwise Reader.** The triage library is Inbox, Later and Archive: new items land in Inbox, and you archive (`E`), move to Later (`L`) or back to Inbox (`⇧E`) one at a time; `⌘K` and `?` show every key. [19]
- *Works:* triage is one key per item, and Archive is a place you can always open.
- *Doesn't:* three states are one more than notes need; "Later" is what pins and the Feed itself already are.

**Superhuman.** `E` marks done (archives), `H` reminds later, `Z` undoes; Split Inbox divides mail into tabs you move between with Tab; Done is reachable with `G` `E` or `⌘K`; mass archive clears old mail. [20][21][22]
- *Works:* Tab between splits; undo with one key; done is safe because search still finds it.
- *Doesn't:* many keys to learn; the Feed should start with five.

**Gmail.** `j`/`k` move, `e` archives, `#` deletes. Archive takes mail out of the inbox but keeps it in All Mail; Trash is deleted forever after 30 days. Search filters: `in:`, `is:`, `has:`, `from:`, `older_than:`. [23][24][25]
- *Works:* the clearest split there is between archive (keep, out of the way) and trash (goes away in 30 days). Its filter syntax is widely known.
- *Doesn't:* a reply brings an archived thread back to the inbox, which suits mail. For notes, whether an agent's edit should do the same is your call (decision 3).

**Things.** Inbox for what isn't sorted yet; Today, Upcoming, Anytime, Someday; completed to-dos go to the Logbook. [26][27]
- *Works:* a Logbook means done things are out of sight but kept, in time order.
- *Doesn't:* many fixed lists; notes don't need scheduling buckets.

**Mem.** A timeline of notes in time order, sortable by created or modified, plus collections and smart search. [28][29]
- *Works:* a timeline is a fine home for notes.
- *Doesn't:* AI-suggested organization moves things for you; Common Ink wants changes you can see and undo.

**Reflect.** Daily notes as a scrolling chronology; backlinks; `⌘K` for search and commands, with relative dates. [30][31]
- *Works:* daily notes as a stream, `⌘K` for everything.

**Tana.** Supertags give nodes types with fields; live searches gather tagged nodes and run only while expanded. [32][33]
- *Works:* saved queries as first-class objects. *Doesn't:* heavy concepts and syntax.

**Capacities.** Everything is a typed object; daily notes are the hub; calendar events from Google and others appear in the daily note's timeline and become objects you can link. [34][35]
- *Works:* events next to the day's notes. *Doesn't:* turning events into objects blurs what you wrote and what Google owns, which ADR 0007 rejects for good reasons.

**Apple Notes.** Pin a note to the top of its list; smart folders gather notes by tag, date, mentions or checklists, and hold references, not notes; tags in the sidebar. [36][37]
- *Works:* pinned at the top of the same list; smart folders as references, not moves.

**Notion.** The sidebar has Favorites, Teamspaces, Shared and Private; sections collapse and reorder by dragging. Trash keeps pages 30 days, and restoring puts a page back where it was with its subpages. Search filters by date, created by and teamspace, and sorts by created or edited. [38][39][40]
- *Works:* favorites first; trash that restores in place.
- *Doesn't:* a deep page tree in the sidebar is storage, and it grows without end.

### 4.3 Trash with retention

| App | Retention | Restore | Delete now | Notes |
| --- | --- | --- | --- | --- |
| Gmail [23] | 30 days | Move out of Trash | Delete forever | Archive is separate and never expires |
| Notion [38] | 30 days | To its original parent | Delete from trash | Enterprise can change the period |
| Apple Notes [41] | 30 days | Recover | Delete | Removed from every device |
| Google Drive [42] | 30 days (since 2020, was forever) | Restore | Delete forever | Changed to match Gmail, "consistent and predictable" |
| macOS Finder [43] | 30 days, **off by default** | Put Back | Empty Trash | A setting, Finder › Settings › Advanced |

Thirty days is the shared convention: everyone has it, and Google changed Drive to it on purpose. Restore always means "back where it was". A setting for the period (macOS, Notion Enterprise) fits Common Ink's settings-in-JSON principle.

### 4.4 Search

- **Raycast**: one bar for everything; an action panel on the selected result. [14][16]
- **Linear**: `⌘K` for actions by name; `/` filters the list you're in; filters save as views. [9][11]
- **Obsidian**: `file:`, `path:`, `tag:`, `line:`, `section:`, `task-todo:`; operators combine; "Explain search term" shows how a query parsed. [44]
- **VS Code**: a Search view with "files to include" and "files to exclude" globs, regex and case toggles; results grouped by file with matching lines. [45]
- **Gmail and Superhuman**: `from:`, `in:`, `is:`, `has:`, relative dates; the syntax people already know. [24][20]
- **Notion**: filters by date, creator and teamspace; sort by created or edited. [40]

What to take: Gmail's operator words (`is:`, `in:`, `from:`, `has:`), Obsidian's "explain" idea (the query is shown as text everywhere in the prototype), Raycast's actions on a result, Linear's "a filtered list can be saved", and VS Code's results-as-a-view for when you want to work through many.

### 4.5 Data sources

- **Notion Calendar** (was Cron): attach a Notion page to an event from the event's side panel, or make a new one; the page link travels with the invite. [46][47]
- **Capacities**: events from connected calendars show in the daily note's timeline and become linkable objects. [34][35]
- **Fantastical**: Calendar Sets switch which calendars show; natural language adds events, `/` picks the calendar. [48][49]

What to take: data from outside shows **where it's used** (a calendar view, the day's agenda, chips in notes, search results), not as a folder of its own; a source's own place is for status and settings. This is what ADR 0007 already does, and the design keeps it.

## 5. Answers to the study's questions

### 5.1 Where views live

Four locations, three of them now:

| Location | What goes there | How many at once | v2 today |
| --- | --- | --- | --- |
| **Places** (left) | Places to go: the Feed, Search, extensions' places, pins, saved searches, Sources, Archive, Trash, Extensions, Settings | One list | The flat notes list |
| **Editor area** (centre) | Notes, and every place when opened: the Feed, Calendar, Tasks, Trash, search results | Tabs and splits | Workbench windows |
| **Context panel** (right) | Views about the note in focus: History, Links, Agenda, Outline, an extension's view | One at a time, with a switcher | The side panel |
| **Bottom panel** | Reserved: logs and long-running output (Extension activity, Problems) | Off until an extension needs it | None |

**How extensions contribute.** A manifest declares `places` (a place in the list that opens a view or a query) and views with a `location` (`editor`, `context`, later `panel`). Today's `views.sidebar` means the context panel and keeps working. See [7.6](#76-extension-api).

**How you rearrange.** Everything is in `.common-ink/places.json` (order, hidden places, saved searches) and `layout.json` (where each view is), so it can be edited by hand, by an agent, and undone. From the keyboard: `J`/`K` move a place in the list, `dd` removes a saved search, and `m` on a context view opens "Add to Places / Open as a tab / Close the panel". Dragging (Workbench's `data-open`) does the same with a mouse.

### 5.2 The Feed

**What it shows.** Every note that isn't archived, ordered by its last change, whoever made it: you, an agent, or an extension. Pinned notes first, under "Pinned". Then groups by date: Today, Yesterday, This week, This month, then by month. Filters across the top, as X's tabs: **All**, **Mine** (`from:me`), **Agents** (`from:agent`, with a count of unseen changes). The query the Feed is showing is written next to its title (`-is:archived sort:edited from:agent`) so nothing about it is hidden.

**A card.** Title, folder, time; who made the last change, their summary (from `ctx.changes.describe`, or an agent's own words), and the diff's size (`+12 −3`); badges for agent, pinned and archived. Then the note's first nine or so lines, drawn as live preview draws them: headings, lists, links, event chips, due dates. **Tasks are live**: ticking one in a card is a change by you, as in v1. **Embeds are quiet** by default: a dashed line that says what it is ("◷ Timer 25m", "▦ Calendar 3 days", "▤ Board 3 columns"), drawn live only on the focused card after a short pause (`feed.liveEmbeds: "focused"`), because a feed of live iframes is slow and noisy. Try all three in the prototype's controls. `c` shows the last change as a diff inside the card; `v` switches cards to one-line rows for fast scanning.

**Scrolling.** Load 30 cards at a time and more as you near the end (the prototype loads the next 30 as you scroll or `j` past the 25th). New changes that arrive while you're scrolled down don't move the list; a pill says "↑ 2 new changes", as X does. Leaving and coming back (`↵` then `Ctrl-O`) returns to the same card.

**Keys.** Only while the Feed has focus, never while typing:

| Key | Does | From |
| --- | --- | --- |
| `j` `k`, `gg` `G` | Next, previous, top, bottom | Vim, Gmail |
| `↵` | Open the note | everyone |
| `o` | Open beside; the reading pane then follows `j`/`k` | Superhuman, Reader |
| `e` | Archive (or unarchive) | Gmail, Superhuman, Reader, v1 |
| `#` or `dd` | Move to Trash | Gmail; Vim |
| `p` | Pin or unpin | v1's `s` star; "pin" in ADR 0003 |
| `x` | Select, then `e`/`#`/`p` act on all selected | Gmail, v1 |
| `t` | Tick the card's next open task | new |
| `c` | Show the last change | new |
| `u` (or `⌘Z`) | Undo the last triage | Vim; Superhuman's `Z` |
| `/` | Filter the Feed with the query language | Linear, v1 |
| `v` | Cards or rows | Linear's view switch |
| `Tab`, `⇧Tab` | All, Mine, Agents | Superhuman's splits |

Keys match the character typed, so they work on Dvorak.

**Archive is a state, kept in a file.** Of the three options:

| Option | For | Against |
| --- | --- | --- |
| A folder, `Archive/<path>` (v1) | Plain to see in the file list | Every archive is a rename: history, links, labels and pins must follow it, and v2 has no rename yet; the note's path changes under agents |
| Frontmatter, `archived: true` | Travels with the note | ADR 0003 forbids it; it's a second format in every note |
| **A list in `.common-ink/archive.json`** | The note doesn't move or change; links, labels and history are untouched; one file holds every archived path, so it's easy to read; its history is the archive log, with who and when; undo is undoing that change; agents read it like any file | A rename must update it (and pins, and labels) in the same change |

The last is the recommendation, and matches how labels already work (`.common-ink/labels.json`). One path per line, sorted, so a diff shows exactly what was archived:

```json
{
  "archived": [
    "Meetings/Q2 retro.md",
    "Projects/Onboarding v1.md"
  ]
}
```

**Agents' activity.** Every card says who made the last change, in purple for agents, with their summary. A purple dot marks notes an agent changed since you last opened them; the Feed's place shows "3 new". The Agents filter shows only agents' changes, including changes to archived notes (marked "archived"), so an agent's work on something you archived is never hidden but doesn't clutter the Feed. A run of changes by one agent to one note is one card ("Claude made 5 changes"; `feed.groupAgentChanges`). The full record stays in History.

What "seen" means has to be stored somewhere visible. The smallest choice is one number per person, the revision you'd seen up to when you last left the Feed, in `.common-ink/users/<you>/feed.json`; a note you open is seen too. It writes a change once a visit, not on every card. If even that is too much churn in history, drop the dots (decision 11).

### 5.3 Archive, Trash and Delete

| | **Archive** | **Trash** (Delete) | **Purge** (Delete forever) |
| --- | --- | --- | --- |
| Means | "Done with it; keep it" | "I don't want this" | "This must be gone" |
| The note | Stays where it is, unchanged | Gone from the workspace | Gone |
| Its history | Untouched | Kept, with the delete change | Its text leaves history; a line remains saying it was purged, by whom and when |
| Representation | Its path in `.common-ink/archive.json` | The delete change in history; no file | A purge change with no text |
| Shows in | Archive; search, last and marked; links still work | Trash, with days left; links to it say "in Trash · Restore" | Nowhere |
| Feed, `⌘P`, agents' listings | Out of the Feed; last in search; `list_files` marks it `archived` | Not listed | Not listed |
| Undo | Undo the change to `archive.json` (`u` right after; any time from History) | Restore = undo the delete change, within 30 days | No |
| Who | You and agents | You and agents | You only; agents can't (as v1) |
| Keys | `e`, `⌘⇧E`, `:archive` | `#`, `dd`, `⌘⌫`, `:trash` | `D` in Trash; `⌘⇧⌫` Empty Trash; both ask |

**Retention.** `trash.retentionDays` is a workspace setting, default 30, in the settings editor with the rest. The workspace's Durable Object already has alarms; once a day it purges notes deleted more than that many days ago. Trash shows a bar and "purges in N days" on every row, red in the last three days.

**Restore.** Restoring undoes the delete change, so the note comes back at its path with its whole history. If another note now has that path, it comes back as `<name> (restored).md`. Uploads deleted with the same rules come back too; records (events) aren't in Trash: they're deleted through their data source, Google keeps its own trash, and history can still undo the change.

**History and undo.** Both are history. Archiving is an ordinary change to a JSON file, so "undo what the agent did" covers an agent archiving your notes. Deleting is the change history already records. Purging is the one change that removes text from history, so it's the one that can't be undone and the one agents can't make. Every purge leaves a line in history; nothing disappears without a trace.

### 5.4 Navigation model

**Feed, file tree, search or smart folders?** All four, each in its place, with the Feed as home:

- **The Feed** is how you see what's happening and keep it tidy. It's where you start.
- **Search** is how you find a note you know. One bar, always a keystroke away.
- **Saved searches** (v1's smart folders) are how you keep a list you come back to: a project, "agent edits this week". They live in Places, with counts.
- **Folders** are storage. They aren't in Places. You filter by one with `in:Projects/`, and saving that gives you a place. (A file tree can come back as an extension's view if you miss it; decision 12.)

**Where things live.**

| Thing | Where | Why |
| --- | --- | --- |
| Daily notes | "Today" place (`g d`) opens today's note; daily notes are also in the Feed like any note | Daily notes extension contributes the place |
| Tasks | "Tasks" place: open tasks across notes by due date | Tasks extension |
| Calendar | "Calendar" place (the full view), "Agenda" in the context panel, chips and `::calendar` in notes, events in search | Calendar extension contributes all four |
| Data sources | "Sources" at the bottom of Places: status, sync, outbox, reconnect. A dot shows trouble; the status bar says "Reconnect" only when needed (as now) | A source has no notes of its own |
| History | Context panel (this note); "Show history of everything" opens as a tab | History extension |
| Settings, Extensions | Bottom of Places, and `⌘,` | Core: they must work with every extension off |
| Archive, Trash | Bottom of Places, with counts | Quiet, always reachable |

**How data sources appear.** Not as a folder of records and not as notes. In three places: as **views** where they're used (Calendar, Agenda), as **results in search** (`type:event`, `type:contact`), and as a **status row in Sources**. Opening an event from search opens Calendar on its day, with "Notes that link here" and "Make a meeting note".

### 5.5 Search

**One bar** for notes, tasks, events, contacts, commands and settings. `⌘K` opens it (Linear, Notion, Reflect, Superhuman all use `⌘K`), and so does `⌘P` (as now). `⌘⇧P` or a leading `>` shows commands only. Results come in sections: Notes, Tasks, Events, Contacts, Commands, Settings. With nothing typed, it shows recent notes and the filters you can use.

**Query syntax** (one parser: search bar, Feed filter, saved searches, `search` over MCP and the CLI):

| Filter | Example | Meaning |
| --- | --- | --- |
| words, `"phrase"`, `-word` | `launch "beta date" -draft` | Full text; title matches rank first |
| `is:` | `is:archived` `is:pinned` `is:trashed` `is:open` `is:done` | State |
| `in:` | `in:Projects/` | Folder |
| `from:` | `from:me` `from:agent` `from:claude` `from:sync` | Who made the last change |
| `type:` | `type:note` `type:task` `type:event` `type:contact` `type:command` `type:setting` | One kind of result |
| `edited:` | `edited:today` `edited:<7d` `edited:>90d` | When it last changed |
| `due:` | `due:<=today` | Tasks (added by the Tasks extension) |
| `has:` | `has:task` `has:embed` `has:event` | What a note holds |
| `#tag`, `links:` | `#work` `links:[[Launch plan]]` | Tags and backlinks (later) |

Archived notes are included, last and marked; trashed notes only with `is:trashed`. Extensions add their own filters (`due:` from Tasks, `type:event` from Calendar) in their manifests, so the bar can list and complete them before their code runs.

**Keys.** Type; `Tab` completes a filter (`is:a` → `is:archived`); `↑`/`↓` or `Ctrl-j`/`Ctrl-k` (and `Ctrl-n`/`Ctrl-p`) move; `↵` opens; `Tab` on a result opens its actions (Open, Open beside, Archive, Pin, Copy link; for an event, Make a meeting note); `⌘↵` opens every result as a tab of cards, where `⌘S` saves it as a place.

### 5.6 Staying minimal and keyboard-first

- **Text, not icons**, in one short list. No activity bar, no bottom panel, no new top-bar or status-bar buttons (#135). Places hides with `⌘B`, the context panel with `⌘⌥B`; with both hidden it's a pure editor, the way it is now.
- **Single-letter keys are scoped**: they act only in the Feed and other lists, never in a note or a field. In a note, Vim stays Vim: `:archive`, `:trash`, `:feed`, and `Ctrl-O` back to the card you came from.
- **Go keys** (`g f` Feed, `g /` Search, `g d` Today, `g t` Tasks, `g c` Calendar, `g a` Archive, `g x` Trash, `g s` Sources, `g e` Extensions, `g ,` Settings) work outside text, like Linear's and Gmail's.
- **Vim's window keys move focus** between Places, the editor area and the context panel: `Ctrl-W h`/`l`/`w`.
- **Five keys to start** in the Feed (`j` `k` `↵` `e` `#`); the rest are there when you want them, and `?` lists them all.

## 6. Three navigation models

Each one end to end, with the same five flows.

### Model A: Workbench (VS Code)

An activity bar of icons on the far left (Notes, Search, Calendar, Tasks, Sources; Extensions and Settings at the bottom). Each opens a container in the side bar. Notes holds collapsible views like VS Code's Explorer: Pinned, Recent (the feed as a list of titles with who and when), Archive, Trash. Search is a side bar view with "in" and "from" fields and toggles for archived and trash, results grouped by note with matching lines. A secondary side bar on the right holds History. A bottom panel (`⌘J`) holds Activity (every recent change, by whom) and Extension activity. Views move between the side bar and the panel from their `⋯` menu; icons reorder by dragging or `J`/`K`.

- *Triage:* `⌘⇧E`, then `j`/`k` in Recent, `e`, `#`, `p`. Fast, but you triage titles, not content; reading means opening each note.
- *Find a note:* `⌘P` by name, or `⌘⇧F` for text with fields.
- *Open an event:* Calendar container, then the event opens as a tab.
- *Restore:* open the Trash section, `r`.
- *Add an extension's panel:* it adds a view; drag it to a container, the secondary side bar or the panel.
- **For:** familiar to a programmer; ADR 0006 already expects it; scales to many extensions; agent activity has a natural home in the bottom panel.
- **Against:** the most chrome of the three; icons to learn; the "feed" is a list, so it doesn't give the reading-and-scrolling feel you asked for; three places to look for things (side bar, secondary side bar, panel).
- **Prototype:** [navigation-workbench.html](prototypes/navigation-workbench.html).

### Model B: Feed only

No sidebar at all. The Feed fills the editor area as home. Everything else is a tab you open from the search bar or with go keys: Calendar, Tasks, Trash, Archive, Settings. Context views open on demand on the right. Saved searches appear as tabs across the top of the Feed (All, Mine, Agents, Projects…), as X's and Superhuman's tabs do.

- *Triage:* the same as the recommendation.
- *Find a note:* `⌘K` only.
- *Open an event:* `⌘K` "dentist", `↵`.
- *Restore:* `g x`, `r`.
- *Add an extension's panel:* it's a command and a tab; there's no place to pin it except as a Feed tab.
- **For:** the least chrome; the editor is always full width; nothing to arrange.
- **Against:** nothing to see at a glance (counts, pins, what's there); weak for the occasional place you don't remember the key for; extensions' places have no home but the command bar; tabs across the Feed grow as saved searches do.
- **Prototype:** the recommended prototype with Places hidden (`⌘B`) is this model.

### Model C: Places and the Feed (recommended)

Places on the left as one short text list; every place opens in the editor area; context views on the right; one search bar; every list a query. Described in full in section 7.

### Comparing them

| | A: Workbench | B: Feed only | C: Places + Feed |
| --- | --- | --- | --- |
| Chrome | Most | Least | Little, and hides |
| Reading feel of the Feed | List of titles | Cards | Cards |
| At a glance (pins, counts, saved searches) | Yes | No | Yes |
| Keyboard | Good | Best | Best |
| Extensions' views | Containers and views; many slots | Commands and tabs only | Places and context views |
| Agent activity | Bottom panel log, and dots | Feed | Feed (Agents) and History |
| Matches ADR 0006 | Exactly | Loosely | Mostly: places are the "view containers", opened as tabs |
| New concepts | Container, view, panel, secondary side bar | None | Place, context panel |
| Cost to build | High | Low | Medium |

## 7. Recommended model: Places and the Feed

### 7.1 Information architecture

```text
┌ Places ─────────────┬ Editor area (tabs, splits) ─────────────┬ Context panel ─────────┐
│ Feed        3 new   │  Feed │ Launch plan │ Calendar           │ History  Links  Agenda │
│ Search              │                                         │                        │
│ Today               │  Feed  -is:archived sort:edited         │ Launch plan            │
│ Tasks               │  [All] Mine  Agents 3                   │ Claude  +12 −3         │
│ Calendar            │                                         │ 4 min ago · Added a    │
│                     │  PINNED                                 │ risks section          │
│ PINNED              │  ┌ Launch plan  Projects     4 min ago ┐│ You  +6 −0             │
│ • Launch plan       │  │ Claude · Added a risks …  +12 −3    ││ 2 days ago             │
│ • A feed for notes  │  │ ☐ Record the demo video  Oct 7      ││                        │
│                     │  └─────────────────────────────────────┘│                        │
│ SAVED SEARCHES      │  TODAY                                  │                        │
│ Agent edits…     6  │  ┌ 2026-10-05  Journal      22 min ago ┐│                        │
│ Projects         2  │  │ ◷ Timer 25m                         ││                        │
│                     │  └─────────────────────────────────────┘│                        │
│ Sources          ●  │                                         │                        │
│ Archive          4  │                                         │                        │
│ Trash            4  │                                         │                        │
│ Extensions          │                                         │                        │
│ Settings            │                                         │                        │
├─────────────────────┴─────────────────────────────────────────┴────────────────────────┤
│ NORMAL  Saved                     j/k · ↵ open · o beside · e archive · # trash   09:00 │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Places, top to bottom:**

1. **Places you go:** Feed, Search, then what extensions add (Today from Daily notes, Tasks, Calendar), in the order in `places.json`.
2. **Pinned:** your pinned notes, in pin order.
3. **Saved searches:** named queries, with live counts.
4. **At the bottom:** Sources (with a status dot), Archive and Trash (with counts), Extensions, Settings.

Settings and Extensions stay in the core, so turning every extension off still leaves a way back (ADR 0006). With the Feed extension off, Places still lists the rest, and the editor area opens on the last layout.

**New vocabulary** for CONTEXT.md, if you choose this:

- **Place**: something listed in Places that opens in the editor area: a view an extension adds, a pinned note, or a saved search. _Avoid_: section, nav item.
- **Feed**: the place that lists notes by their last change, with triage keys. _Avoid_: timeline, inbox.
- **Saved search**: a query with a name, kept in `places.json`. _Avoid_: smart folder (v1's word), filter, view.
- **Archived**: a note listed in `archive.json`: kept, out of the Feed. _Avoid_: hidden.
- **Trash**: the notes deleted in the last `trash.retentionDays` days, listed from history. _Avoid_: bin, recycle.
- **Purge**: removing a deleted note's text from history. _Avoid_: hard delete.
- **Context panel**: the right-hand panel of views about the note in focus. _Avoid_: sidebar, inspector.

### 7.2 Key flows

All five work in the prototype.

**Triage the Feed.** `g f` (or click Feed). `j`/`k` through cards; the focused card shows its keys underneath. `e` archives with a toast "Archived 'Reading list' · a change to archive.json · Undo `u`" and the card slides out. `#` sends one to Trash. `p` pins (it jumps to Pinned). `x` on several, then `e`, archives them in one change. `o` opens the note beside the Feed; `j`/`k` then change what's beside, like a mail client's reading pane. `Tab` to Agents to see only what agents did; the purple dots go as you look. When the Feed is empty: "Inbox zero for notes."

**Find a note.** `⌘K`, type `launch`. Notes whose titles match come first, then ones whose text matches with the line shown and the words marked; tasks, events and contacts in their own sections. Add `in:Projects/` (Tab completes it). `↵` opens. Or `Tab` for actions and `e` to archive it without opening. Or `⌘↵` to see all results as cards, and `⌘S` to save them as a place.

**Open a calendar event.** `⌘K`, type `dentist`. The event is under Events with its day and time. `↵` opens Calendar at that day with the event selected and its details below: where, which calendar, "Notes that link here" and `n` to make a meeting note. `↵` on the event opens the note that links to it. (In a note, clicking an event chip does the same.)

**Restore from Trash.** `g x`. Each row says when it was deleted, by whom, and how long it has left, with a bar. `↵` shows the last version, read-only. `r` restores it: "Restored 'Untitled 3' to Untitled 3.md, with its history". `D` deletes one forever after asking; `⌘⇧⌫` empties Trash after asking.

**Add an extension's panel.** `g e`, select Word count in the Catalog, `↵` to install. Its row says what it adds ("Panel: Word count") before anything runs. It appears in the context panel's switcher and opens there. `Ctrl-W l` to the panel, `m`: "Add to Places", "Open as a tab" or "Close the panel". Adding to Places writes `places.json`, and it's undoable like any change.

### 7.3 Keyboard map

Mod is `⌘` on a Mac and `Ctrl` elsewhere. Keys match the character typed (Dvorak-safe), through `web/src/keys.ts`.

| Where | Keys |
| --- | --- |
| **Anywhere** | `⌘K` or `⌘P` search · `⌘⇧P` commands · `⌘B` Places · `⌘⌥B` context panel · `Ctrl-O`/`Ctrl-I` back/forward · `Ctrl-W h`/`l`/`w` move focus · `?` keys (outside text) |
| **Go** (outside text) | `g f` Feed · `g /` Search · `g d` Today · `g t` Tasks · `g c` Calendar · `g a` Archive · `g x` Trash · `g s` Sources · `g e` Extensions · `g ,` Settings |
| **Feed and lists** | `j` `k` `gg` `G` · `↵` open · `o` beside · `e` archive · `#` or `dd` trash · `p` pin · `x` select · `t` tick a task · `c` changes · `u` undo · `/` filter · `v` cards or rows · `Tab` All, Mine, Agents · `Esc` clear selection or close beside |
| **In a note** | `⌘⇧E` archive · `⌘⌫` trash · Vim: `:archive`, `:unarchive`, `:trash`, `:pin`, `:feed` · `Ctrl-O` back to the card |
| **Trash** | `r` restore · `↵` look inside · `D` delete forever · `⌘⇧⌫` empty |
| **Places** | `j` `k` · `↵` or `l` open · `J` `K` move · `dd` remove a saved search |
| **Context panel** | `Tab` next view · `m` move this view |
| **Search** | `Tab` complete a filter, or actions on a result · `↑`/`↓`, `Ctrl-j`/`Ctrl-k` · `↵` open · `⌘↵` all as a tab · `⌘S` save as a place |

Every one is a command with a title, so `⌘⇧P` finds it and settings can rebind it (as keybindings work now). The `g` keys are not Vim sequences; inside a note's editor, `g` stays Vim's.

Two clashes to know about: in browsers `⌘⌥B` is Chrome's bookmarks manager on some setups, and off a Mac `Ctrl-W` closes the browser tab, which a page can't stop. The app already lives with the second for Vim's `Ctrl-W`; an installed app (PWA) gets both keys.

### 7.4 Data model

New files, all JSON with a schema, all in history:

| File | Holds | Written by |
| --- | --- | --- |
| `.common-ink/archive.json` | `{"archived": [paths, sorted]}` | archive and unarchive operations |
| `.common-ink/pins.json` | `{"pinned": [paths, in order]}` | pin and unpin |
| `.common-ink/places.json` | `{"order": [place ids], "hidden": [ids], "saved": {"name": "query"}}` | Places, and saving a search |
| `.common-ink/users/<you>/feed.json` | `{"seenThrough": <revision>}` | leaving the Feed (only if decision 11 is yes) |

No new file for Trash. It's a query over history:

```sql
-- Notes deleted in the last N days and not there now (worker/src/files.ts has the changes table)
SELECT path, revision, author, time FROM changes
WHERE deletes = 1 AND time > :since AND path NOT IN (SELECT path FROM files)
ORDER BY time DESC;
```

**Operations** (in `worker/src/operations.ts`, so the app, MCP and the CLI share them, per principle 3):

- `archive(paths)`, `unarchive(paths)`: one change to `archive.json`.
- `pin(paths)`, `unpin(paths)`.
- `trash()`: what's in Trash, with days left. `restore(path)`: undo the delete change.
- `purge(path)`: removes the path's changes from history and writes a purge change with no text. Not offered over MCP or to agents' CLI; the app asks first.
- `search(query, limit)`: the query language over a full-text index (SQLite FTS5 in the workspace's Durable Object), returning notes, and from data sources, events and contacts.
- `list_files` gains `archived: true` on archived notes.

**Retention.** A daily Durable Object alarm purges deletes older than `trash.retentionDays`. Each purge is a change by `retention`, so History shows it.

**Rename.** When v2 gets a rename (it has none today), the rename writes the note and updates `archive.json`, `pins.json`, `labels.json` and saved searches that name it, as one change.

**Should pins and archive be per person?** Today a workspace is one person, so they're workspace files. When workspaces are shared, pins become per person (`.common-ink/users/<you>/pins.json`, as v1's stars were), and archive stays shared. That's decision 5.

### 7.5 History and undo, together

- `u` right after a triage undoes it: the change to `archive.json`, `pins.json`, or the delete. It's the same undo as everywhere (ADR 0002).
- History's filter by author ("undo what the agent did") also covers an agent archiving or deleting notes.
- Trash's Restore is undo of one specific change, so it works even after many other changes.
- Purge is the one thing undo can't reach, which is why it asks, can't be done by agents, and leaves a line.

### 7.6 Extension API

What the manifest and `ctx` would need. Everything is declared first, so Places, the context panel and search know about an extension before its code runs (ADR 0006).

```json
{
  "id": "calendar",
  "contributes": {
    "places": [{ "id": "calendar", "title": "Calendar", "view": "calendar", "go": "c" }],
    "views": {
      "editor": [{ "id": "calendar", "name": "Calendar" }],
      "context": [{ "id": "agenda", "name": "Agenda" }]
    },
    "search": {
      "types": [{ "type": "event", "title": "Events" }],
      "filters": [{ "filter": "on:", "description": "Events on a day", "values": ["today", "tomorrow"] }]
    }
  }
}
```

- **`contributes.places`**: `id`, `title`, and one of `view` (a view this extension declares), `query` (a saved search it ships, such as Tasks' "Due this week") or `command`; an optional `go` letter for `g <letter>`. Order and hiding are yours, in `places.json`.
- **`contributes.views`** gains locations: `editor` (opens as a tab, the default for places), `context` (the context panel), and later `panel` (bottom). `sidebar` stays as another name for `context`, so today's manifests keep working.
- **`contributes.search`**: result `types` the extension answers and `filters` it adds, each with a description and values for completion.
- **`ctx.search.provide(type, { search(query, limit) })`**: answers a parsed query (`common-ink/query` gives every extension the same parse). Results carry a title, detail, an icon character, an address and actions.
- **`ctx.feed.decorate(fn)`**: adds a badge to a card ("3 open tasks · 1 overdue" from Tasks). No other way to change cards.
- **Embed contributions gain `summary`**, a template like `"Timer {duration}"`, which the Feed shows instead of drawing the embed, with no code running.
- **`common-ink/query`**: the query parser and matcher as a library, shared by the Worker, the app and extensions.
- **`ctx.places.reveal(id)`, `ctx.views.move(id, location)`**: so an extension's command can open its place or move its view; the user's choice in `layout.json` wins.

### 7.7 Risks

- **Purging edits history**, which ADR 0002 treats as the source of truth. It's per file, and history is per file, so it's contained, but it needs a property test: purge any path at any point and every other file's history replays the same.
- **Full-text search** is new infrastructure (FTS5 in the Durable Object, kept in step in the same transaction as writes, as the records index is).
- **Live tasks in cards** write from a list, not an editor; they must merge like any edit (ADR 0002 already merges).
- **History noise**: every triage key is a change. Changes to `.common-ink/` are already in history (layout.json is); History's filter should hide them by default.

## 8. Build plan

Pull-request sized, in order. Each ships something you can use, with its own Preview and a "Try this PR" note.

1. **Query library.** `common-ink/query`: the parser and matcher for words, `is:`, `in:`, `from:`, `type:`, `edited:`, `has:`, with property tests. No UI.
2. **Full-text index and `search`.** FTS5 in the workspace's Durable Object, updated in the write transaction; the `search` operation over MCP and the CLI (`common-ink search 'launch in:Projects/'`).
3. **Archive.** `archive.json`, the `archive`/`unarchive` operations, `:archive`, `⌘⇧E`, the banner on an archived note, `archived` in `list_files`, archived last in `⌘P`.
4. **Trash and Restore.** The Trash view as a tab (from the command bar until Places lands), Restore as undo of the delete, "in Trash · Restore" on links to a deleted note.
5. **Purge and retention.** `purge`, Delete forever, Empty Trash, the daily alarm, `trash.retentionDays`, the property test.
6. **Places.** Replace the notes list: `contributes.places`, `places.json`, `⌘B`, `J`/`K`, go keys. Daily notes, Tasks and Calendar contribute their places. Pins (`pins.json`, `p`, `:pin`).
7. **The Feed.** A default extension: cards, date groups, pinned first, `j`/`k`/`↵`/`o`/`e`/`#`/`dd`/`p`/`x`/`u`, scrolling in pages, the new-changes pill, quiet embeds with `summary`.
8. **Agents in the Feed.** All, Mine, Agents; summaries from `ctx.changes.describe`; grouping runs of an agent's changes; `c` for the diff; unseen dots (if decision 11).
9. **One search bar.** `⌘K`, sections, filter completion, providers from extensions (`contributes.search`: events, contacts, tasks, settings), actions on results, `⌘↵` results as a tab, `⌘S` save as a place.
10. **The context panel.** The switcher, `views.context`, `m` to move a view, `Ctrl-W` focus. Links (backlinks) as a default extension.
11. **Live embeds on the focused card** (`feed.liveEmbeds`), once 7 has been lived with.
12. **Bottom panel**, only if something needs it.

Steps 1 to 5 are useful alone and don't depend on the navigation decision. Steps 6 onwards follow it.

## 9. Testing with you

There's no one else to recruit, so the plan is three short sessions with you, using the prototypes first and Previews later. Each task has a goal you can check yourself; time it if you like.

### Session 1: prototypes (30 minutes, now)

Open both prototypes side by side. For each, do the tasks without the mouse, then answer the questions.

| # | Task | Success looks like |
| --- | --- | --- |
| 1 | Get the Feed down to what you want to keep: archive 5, trash 2, pin 1 | Under 90 seconds, no mouse, no mistake you needed to undo (or the undo felt easy) |
| 2 | Find what agents changed today and look at what they changed | You reach the Agents filter or `from:agent` and use `c` or `o` without the `?` sheet |
| 3 | Find the note about trash retention | Under 15 seconds from anywhere |
| 4 | Open tomorrow's dentist appointment and the note that links to it | Under 20 seconds; you knew where events would be |
| 5 | Restore the deleted "Untitled 3" | Under 15 seconds; you were sure what Restore would do |
| 6 | Install Word count and put its view in Places | Under 30 seconds |
| 7 | Save "notes in Projects that mention launch" as a place | Under 20 seconds |

Questions after:

1. Which one did you want to keep using? Why?
2. Did the cards tell you enough to archive without opening the note? What was missing or too much?
3. Did quiet embeds feel right, or did you want them live? (Try the three settings in the prototype controls.)
4. When an agent changed an archived note, did you want it back in the Feed?
5. Did anything feel hidden, or anything feel like clutter?
6. Was there a key you reached for that didn't work?

### Session 2: a week on a Preview (after build step 7)

Use the Feed as home for a week. Add a line to the day's journal when something annoys you. Measured from history, not memory:

- Triage actions per day, and how many were undone within a minute (a high undo rate means a key is in the wrong place).
- Restores from Trash (each one means a delete was a mistake or Trash was used as "later").
- How often you open Archive (if never, it's working; if often, archive is being used as "later" and pins might not be enough).
- Whether you still use `⌘P` more than the Feed to open notes.

### Session 3: search (after build step 9)

Ten real lookups over a few days, each noted with what you typed, whether the first result was right, and whether you used a filter. Success: the first result is right for eight of ten, and filters come to you without the `?` sheet.

## 10. Decisions for you

The choices only you can make. My recommendation is in bold.

1. **Which model?** A: Workbench, B: Feed only, **C: Places and the Feed**.
2. **What to call the Feed?** **Feed**, Notes (v1's word), or Home.
3. **Does an agent's edit bring an archived note back to the Feed?** **No; it shows under Agents, marked archived.** Yes (Gmail's way), as a setting.
4. **Archived notes in `⌘P` and search:** **shown last and marked**, or hidden unless you ask (`is:archived`, v1's way).
5. **Pins: the workspace's or each person's?** **The workspace's now**, each person's when workspaces are shared. Archive stays the workspace's either way.
6. **Trash:** **30 days as a setting (`trash.retentionDays`)**, or fixed. And **agents can't purge** (as v1)?
7. **Embeds in cards:** never, **on the focused card**, or always.
8. **Trash key:** **both `#` and `dd`**, or one of them. And **`p` for pin**?
9. **What opens when the app starts:** **your last layout, with the Feed when nothing's open**, or always the Feed.
10. **Activity bar icons, or text Places?** **Text**, collapsible to nothing with `⌘B`.
11. **Unseen dots for agents' changes**, which means a small `feed.json` change once per visit: **yes**, or no dots.
12. **A file tree:** **not in Places** (folders by `in:` and saved searches), or as an optional view for those who want one.
13. **Bottom panel:** **not until something needs it**, or now for Extension activity.

## 11. Sources

Navigation and panels

1. VS Code, User interface: https://code.visualstudio.com/docs/getstarted/userinterface
2. VS Code, Activity Bar (UX guidelines): https://code.visualstudio.com/api/ux-guidelines/activity-bar
3. VS Code, Views (UX guidelines): https://code.visualstudio.com/api/ux-guidelines/views
4. VS Code, Contribution Points: https://code.visualstudio.com/api/references/contribution-points
5. Obsidian Help, Workspace: https://obsidian.md/help/workspace
6. Obsidian Help, Workspaces plugin: https://github.com/obsidianmd/obsidian-help/blob/master/en/Plugins/Workspaces.md
7. Zed, Introducing Zed's new panel system: https://zed.dev/blog/new-panel-system
8. Zed, All Settings: https://zed.dev/docs/reference/all-settings
9. Linear, Inbox: https://linear.app/docs/inbox
10. Linear, Select issues: https://linear.app/docs/select-issues
11. Linear, Invisible details (on keyboard design): https://medium.com/linear-app/invisible-details-2ca718b41a44
12. Arc browser overview (Wikipedia): https://en.wikipedia.org/wiki/Arc_(web_browser)
13. How pinned tabs work in Arc: https://allthings.how/how-do-pinned-tabs-work-in-arc-browser/
14. Raycast Manual, Search Bar: https://manual.raycast.com/search-bar
15. Raycast Manual, Command Aliases and Hotkeys: https://manual.raycast.com/command-aliases-and-hotkeys
16. Raycast Manual, Action Panel: https://manual.raycast.com/action-panel

Feeds and triage

17. X's timeline tabs (For you and Following): https://www.99dollarsocial.com/blog/benefits-of-twitters-chronological-timeline
18. X timeline design, new posts indicator: https://medium.com/@rbnpantha/twitter-x-timeline-system-design-real-time-feed-reposts-and-ranking-at-scale-b1064221af8b
19. Readwise Docs, How to choose a Library configuration: https://docs.readwise.io/reader/guides/workflows/library-configuration
20. Superhuman, Getting started and hitting Inbox Zero: https://blog.superhuman.com/inbox-zero-in-7-steps/
21. Superhuman Help, Achieve Inbox Zero: https://help.superhuman.com/hc/en-us/articles/45295217605523-Achieve-Inbox-Zero
22. Superhuman Help, Mass Archive: https://help.superhuman.com/article/456-mass-archive
23. Gmail Help, Delete messages: https://support.google.com/mail/answer/7401
24. Gmail Help, Refine searches: https://support.google.com/mail/answer/7190
25. Gmail Help, Keyboard shortcuts: https://support.google.com/mail/answer/6594
26. Things Support, Today, Upcoming, Anytime and Someday: https://culturedcode.com/things/support/articles/4001304/
27. Things Support, AppleScript commands (built-in lists, Logbook): https://culturedcode.com/things/support/articles/4562654/
28. Mem, Organize your notes with Collections: https://get.mem.ai/blog/organize-your-notes-with-ai-using-collections
29. Mem, 5 ways Mem helps you find notes: https://get.mem.ai/blog/5-ways-mem-helps-you-find-notes-faster
30. Reflect Academy, How to use Reflect: https://reflect.academy/how-to-use-reflect
31. Reflect Academy, Tips and tricks: https://reflect.academy/tips-and-tricks
32. Tana, Search nodes: https://tana.inc/docs/search-nodes
33. Tana Outliner, Supertags: https://outliner.tana.inc/learn/features/supertags
34. Capacities, Integrations: https://capacities.io/product/integrations
35. Capacities, Calendar and Date 2.0: https://capacities.io/whats-new/release-18
36. Apple Support, Use Smart Folders in Notes on Mac: https://support.apple.com/guide/notes/use-smart-folders-apd58edc7964/mac
37. Apple Support, Use tags in Notes on Mac: https://support.apple.com/guide/notes/use-tags-apdc88ed7f1d/mac

Trash, search and data sources

38. Restore lost or deleted pages in Notion (Trash, 30 days): https://thomasjfrank.com/docs/ultimate-brain/restore-lost-or-deleted-pages/
39. Notion Help, Navigate with the sidebar: https://www.notion.com/help/navigate-with-the-sidebar
40. Notion Help, Search: https://www.notion.com/help/search
41. Apple Support, Delete and recover notes on iPhone: https://support.apple.com/guide/iphone/delete-and-recover-notes-iph904eee369/ios
42. Google Workspace Updates, Drive trash deleted after 30 days: https://workspaceupdates.googleblog.com/2020/09/drive-trash-auto-delete-30-days.html
43. Apple Support, Delete files and folders on Mac: https://support.apple.com/guide/mac-help/delete-files-and-folders-on-mac-mchlp1093/mac
44. Obsidian Help, Search: https://obsidian.md/help/plugins/search
45. VS Code search, files to include and exclude: https://stevekinney.com/courses/visual-studio-code/search-and-replace-vscode
46. Notion Help, Getting started with Notion Calendar: https://www.notion.com/help/guides/getting-started-with-notion-calendar
47. Notion Calendar, Notion pages and attachments: https://cronhq.notion.site/Notion-pages-and-attachments-32d6cd4af4b44764a3d3501565882417
48. Flexibits, Adding events and tasks (Fantastical): https://flexibits.com/fantastical/help/adding-events-and-tasks
49. Flexibits, Fantastical release notes (Calendar Sets, parsing): https://flexibits.com/fantastical/releasenotes

Common Ink

- PRINCIPLES.md; ADR 0002 (history), 0003 (no frontmatter), 0006 (extensions), 0007 (data sources); docs/extensions.md.
- Common Ink v1's README, sections "Notes, archive and Trash" and "Search".
