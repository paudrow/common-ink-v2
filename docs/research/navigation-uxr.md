# Navigation study: places, a feed, archive, trash and search

A UX research study for Common Ink v2: how to organize extensions' views and side panels, a scrollable feed of notes you can triage, archive, a 30-day trash, data sources and search. It is designed **mobile first**: the model starts on a phone and grows into the tablet and desktop layouts. Extensions say what a device needs to have, so Vim, tabs and splits turn off where they don't fit, and the app shows why. The study ends with a recommendation, prototypes, a build plan and the decisions only you can make.

- **Status:** decided on 2026-10-06 (section 12). Being built in the steps of section 10.
- **Prototypes**, each a single HTML file that needs nothing else; open one straight from the repo:
  - [navigation-mobile.html](prototypes/navigation-mobile.html) (**recommended, mobile first**). The same model from a phone up to a laptop. Pick a device in its top bar: Phone, Phone with a Bluetooth keyboard, Tablet, Tablet with a keyboard, Laptop, or a narrow laptop window. Swipes work with a finger or a mouse drag. On a real phone it fills the screen. `?device=phone` (or `tablet`, `laptop`…) in the address picks a device.
  - [navigation-places.html](prototypes/navigation-places.html): the same model on a desktop, explored in depth with the keyboard. It's responsive too: on a narrow screen it gets a bottom bar and a Places drawer.
  - [navigation-workbench.html](prototypes/navigation-workbench.html): the VS Code-style alternative. On a narrow screen its activity bar moves to the bottom.
  - In each one, press `?` (with a keyboard) for every key. "⚙ prototype" or the top bar has the theme and settings.
- **Method:** reading the v2 docs, ADRs and code; running v2 locally (`calendar` scenario) at desktop and phone widths; reading Common Ink v1's README for what it already shipped; and a comparative review of 28 apps and platform guidelines from their own documentation (sources at the end).
- **Revised** after the first draft, at your request: the recommended model now starts from a phone, a section on extensions that depend on the platform was added, and the prototypes, build plan and decisions were updated.

## Contents

1. [The short version](#1-the-short-version)
2. [Where v2 is today](#2-where-v2-is-today)
3. [What v1 taught us](#3-what-v1-taught-us)
4. [Comparative analysis](#4-comparative-analysis)
5. [Answers to the study's questions](#5-answers-to-the-studys-questions)
6. [Mobile first](#6-mobile-first)
7. [Extensions that depend on the device](#7-extensions-that-depend-on-the-device)
8. [Three navigation models](#8-three-navigation-models)
9. [Recommended model: Places and the Feed](#9-recommended-model-places-and-the-feed)
10. [Build plan](#10-build-plan)
11. [Testing with you](#11-testing-with-you)
12. [Decisions](#12-decisions)
13. [Sources](#13-sources)

## 1. The short version

**Recommendation: Places and the Feed, mobile first.** One model at every size.

- **On a phone**, you start in the **Feed**: the notes you and your agents changed, newest first, as cards you can read. **Swipe right to archive and left to trash**, with Undo on a bar at the bottom. Long-press selects several. A **bottom bar** holds three places you choose (Feed, Today and Calendar by default), plus Search and **Places**. Places is a sheet listing everything else: Tasks, pinned notes, saved searches, Sources, Archive, Trash, Extensions and Settings. A note opens full screen; tap its text to edit, with a toolbar above the keyboard that extensions add buttons to. Views about a note (History, Links, Agenda, an extension's view) open as a sheet.
- **As the screen grows**, the same pieces spread out:
  - **The Places sheet becomes a sidebar.** It's the same list.
  - **The note opens beside its list** (two windows) instead of on top of it.
  - **Tabs appear** at 600px.
  - **The sheet of views docks** as a context panel at 1200px.
  - **Search** goes from full screen to a centered dialog.

  Nothing about the desktop is a separate design.
- **A keyboard, whenever there is one**, adds the keys from the first draft: `j`/`k`, `↵`, `e` archive, `#` trash, `p` pin, `x` select, `u` undo, `g` then a letter to go places, `⌘K` to search, and Vim. A phone with a Bluetooth keyboard gets them; a laptop window too narrow for splits keeps them.

**Extensions declare what a device needs to have, not what kind of device it is.** For example, `"requires": { "keyboard": true }` for Vim, `{ "width": "medium" }` for tabs and `{ "width": "expanded" }` for splits. The app checks these against what this device has:
- a keyboard, detected the first time a key is pressed outside a text field;
- the window's width class;
- a fine pointer.

An extension that's off here is listed in Extensions as "Off on this device: needs a keyboard", with an "On here" override. Menu items that need more room say why instead of vanishing. Each device's capabilities, overrides and layout are a file you can read, `.common-ink/users/<you>/devices/<id>/`. Tabs and windows that don't fit are kept, not closed. They come back when the window is wide enough again.

**Every list of notes is a query.** The Feed is `-is:archived sort:edited`, Archive is `is:archived`, and a saved search is a query you named. One parser serves the search bar, the Feed's filter, saved searches, MCP and the CLI.

**Archive is a state, kept in a file. Trash is history.**
- Archiving adds the note's path to `.common-ink/archive.json`. The note doesn't move and there's no frontmatter.
- Trash is a view of the delete changes from the last 30 days. Restore undoes that change.
- After 30 days the note is purged: its text leaves history, and one line in history says it happened.

**Search is one bar** across notes, tasks, events, contacts, commands and settings.
- On a phone it's full screen, with chips that write filters (`is:archived`, `from:agent`, `type:event`) into the query as text.
- With a keyboard, `⌘K` opens it, and Tab completes filters.

The alternative most worth comparing is a **VS Code-style Workbench**: an activity bar of icons, a side bar of collapsible views, and a bottom panel. It's familiar on a desktop, but on a phone it turns into a row of icons over views that cover the editor, and its feed is a list of titles rather than something you read and swipe.

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

**On a phone** (`npm run probe -- --scenario calendar --viewport 375x812`), v2 today is a single-note viewer:
- **No way to move between notes by touch.** Below 40rem the notes list is hidden (`web/src/style.css`), so the only ways to reach another note are tabs already open, or `⌘P`, which needs a keyboard.
- **Desktop chrome stays.** The status bar shows Vim's `NORMAL` on a device with no keyboard, and the tab row is still drawn.
- **Content overflows.** Event chips run off the right edge.

This is the strongest reason to start the redesign from the phone.

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

Each app: the patterns that matter here, what works, and what doesn't. Sources are in [section 13](#13-sources).

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
- *Doesn't:* a reply brings an archived thread back to the inbox, which suits mail. For notes, whether an agent's edit should do the same is your call (decision 14).

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

### 4.6 On phones

**Gmail.** Right and left swipes are set separately in Settings › General › Swipe actions: Archive, Delete, Mark as read or unread, Move to, Snooze, or None. Each action has its own colour and animation as you swipe. [50]
- *Works:* two directions, two actions, each your choice; colour tells you which before you let go.

**Readwise Reader.** Short and long swipes in both directions, each customizable (Account › Customize swipes), including one that marks everything above as seen. Reader shortened the long-swipe distance to make it more fluid. [51][52]
- *Works:* four actions without a menu.
- *Doesn't:* four is hard to remember; short versus long is easy to get wrong.

**Things.**
- Swipe a to-do right to schedule it ("When").
- Swipe it left to select it, then swipe or tap more to add to the selection, and act on them all from the toolbar at the bottom. Dragging down the right edge selects many at once.
- Tap and hold to reorder. [53]
- *Works:* selecting by swiping and then a toolbar of actions; no "edit mode" to find.

**Apple Notes.** Swipe right on a note to pin it; swipe left to delete it, to Recently Deleted for 30 days. [54][41]
- *Works:* the safe action on the right, the destructive one on the left, the convention Bear follows too.

**Bear.**
- Swiping right from the list slides in the sidebar (tags, Archive, Trash).
- Swiping left on a note shows Pin, Trash and More (share, export, copy a link).
- Pressing and holding lifts a note, and the Drop Bar gathers several for one action. [55][56][57]
- *Works:* Archive and Trash live in the sidebar, out of the way.
- *Doesn't:* the edge swipe for the sidebar competes with swipes on rows.

**Craft.**
- On iPhone, the sidebar's sections live on the Home screen; you turn them on or off and reorder them from ⋯ › Customize Home.
- Tabs exist on Mac and iPad, but not on iPhone or the web. [58][59]
- *Works:* tabs only where there's room; the same sections, laid out for the device.

**Linear Mobile.** You customize the bottom toolbar, rearrange the main navigation, and pin projects and documents; Inbox items can be swiped to delete or snoozed. [60][61]
- *Works:* the bottom bar is yours.

**Obsidian mobile.**
- There's no ribbon; its actions are in the navigation bar's menu.
- While you edit, a **mobile toolbar** sits above the keyboard. It's customizable and scrolls sideways for more.
- Pulling down from the top runs one Quick Action (the command palette by default).
- Plugins mark themselves `isDesktopOnly` when they need Node or Electron APIs, and code checks `Platform.isMobile`. [62][63][64]
- *Works:* the keyboard toolbar.
- *Doesn't:* `isDesktopOnly` is about APIs, not input, and it's all or nothing. A plugin that needs only a keyboard has no way to say so.

**Material Design's window size classes.**
- **Compact:** under 600dp. Phones in portrait.
- **Medium:** 600–839. Tablets in portrait and unfolded foldables.
- **Expanded:** 840–1199. Tablets in landscape and small desktops.
- **Large:** 1200–1599.
- **Extra-large:** 1600 and over.

Layouts go from one pane to two to three as the class grows, and list-detail is one of the canonical layouts. [65][66] Apple's iPadOS tab bar similarly turns into a sidebar when there's room. [72]

**The web platform.**
- **Pointer and hover:** the `pointer`, `any-pointer` and `hover` media features say whether there's a fine pointer and whether it can hover, and they can change while the page is open. [67][68]
- **Keyboards:** **nothing says whether a hardware keyboard is attached.** The VirtualKeyboard API, which is Chromium only, is about the on-screen keyboard. [69]
- **The on-screen keyboard:** `visualViewport` reports the area it leaves, so a toolbar can sit just above it. The viewport's `interactive-widget` setting chooses whether the keyboard resizes the page. [70][73]

### 4.7 How others say where something applies

| Approach | Example | What it can say | What it can't |
| --- | --- | --- | --- |
| Device class | Obsidian's `isDesktopOnly` [64] | "Not on phones and tablets" | An iPad with a keyboard; a narrow desktop window |
| Platform keys in expressions | VS Code's `when` clauses (`isWeb`, `isMac`, `isLinux`) [71] | Anything, as an expression | Input capabilities; there's no keyboard or width key |
| Layout by size class | Material and Apple size classes [65][72] | How a layout changes with width | Whether an extension should run |
| Media features | CSS `pointer`, `hover`, width queries [67][68] | Pointer and width, live | Keyboards |

**Takeaways for Common Ink:**
- On phones, the safe action is a swipe right and the destructive one a swipe left. Make both settings.
- Long-press, or a "Select" button, selects several, and a bottom toolbar acts on them.
- Tabs are for wider screens.
- The bottom bar should be yours to set.
- Editing needs a toolbar above the keyboard.
- No app studied lets an extension say "I need a keyboard". A device class is too coarse, and the web can't detect a keyboard directly, so Common Ink has to infer one, remember it per device, and let you correct it.

## 5. Answers to the study's questions

### 5.1 Where views live

Four locations, three of them now:

| Location | What goes there | How many at once | v2 today |
| --- | --- | --- | --- |
| **Places** (left) | Places to go: the Feed, Search, extensions' places, pins, saved searches, Sources, Archive, Trash, Extensions, Settings | One list | The flat notes list |
| **Editor area** (centre) | Notes, and every place when opened: the Feed, Calendar, Tasks, Trash, search results | Tabs and splits | Workbench windows |
| **Context panel** (right) | Views about the note in focus: History, Links, Agenda, Outline, an extension's view | One at a time, with a switcher | The side panel |
| **Bottom panel** | Reserved: logs and long-running output (Extension activity, Problems) | Off until an extension needs it | None |

**How extensions contribute.** A manifest declares `places` (a place in the list that opens a view or a query) and views with a `location` (`editor`, `context`, later `panel`). Today's `views.sidebar` means the context panel and keeps working. See [9.6](#96-extension-api) and, for what a device needs, [7.7](#77-manifest-and-api).

**How you rearrange.** Everything is in `.common-ink/places.json` (order, hidden places, saved searches) and `layout.json` (where each view is), so it can be edited by hand, by an agent, and undone. From the keyboard: `J`/`K` move a place in the list, `dd` removes a saved search, and `m` on a context view opens "Add to Places / Open as a tab / Close the panel". Dragging (Workbench's `data-open`) does the same with a mouse.

**On a phone** the same four become: Places as a sheet from the bottom bar, the editor area showing one window at a time, the context panel as a bottom sheet, and no bottom panel. See [section 6](#6-mobile-first).

### 5.2 The Feed

**What it shows.** Every note that isn't archived, ordered by its last change, whoever made it: you, an agent, or an extension. Pinned notes first, under "Pinned". Then groups by date: Today, Yesterday, This week, This month, then by month. Filters across the top, as X's tabs: **All**, **Mine** (`from:me`), **Agents** (`from:agent`, with a count of unseen changes). The query the Feed is showing is written next to its title (`-is:archived sort:edited from:agent`) so nothing about it is hidden.

**A card.** Title, folder, time; who made the last change, their summary (from `ctx.changes.describe`, or an agent's own words), and the diff's size (`+12 −3`); badges for agent, pinned and archived. Then the note's first nine or so lines, drawn as live preview draws them: headings, lists, links, event chips, due dates. **Tasks are live**: ticking one in a card is a change by you, as in v1. **Embeds are quiet** by default: a dashed line that says what it is ("◷ Timer 25m", "▦ Calendar 3 days", "▤ Board 3 columns"), drawn live only on the focused card after a short pause (`feed.liveEmbeds: "focused"`), because a feed of live iframes is slow and noisy. Try all three in the prototype's controls. `c` shows the last change as a diff inside the card; `v` switches cards to one-line rows for fast scanning.

**Scrolling.** Load 30 cards at a time and more as you near the end (the prototype loads the next 30 as you scroll or `j` past the 25th). New changes that arrive while you're scrolled down don't move the list; a pill says "↑ 2 new changes", as X does. Leaving and coming back (`↵` then `Ctrl-O`) returns to the same card.

**By touch**, swipes do the same: right archives, left trashes, and long-press selects. See [6.2](#62-the-feed-and-triage-by-touch).

**Keys.** With a keyboard, only while the Feed has focus, never while typing:

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

What "seen" means has to be stored somewhere visible. The smallest choice is one number per person, the revision you'd seen up to when you last left the Feed, in `.common-ink/users/<you>/feed.json`; a note you open is seen too. It writes a change once a visit, not on every card. If even that is too much churn in history, drop the dots (decision 17).

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
- **Folders** are storage. They aren't in Places. You filter by one with `in:Projects/`, and saving that gives you a place. (A file tree can come back as an extension's view if you miss it; decision 22.)

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

### 5.6 Staying minimal, touch-first and keyboard-first

- **On touch, the few actions that matter are swipes, one bottom bar and one sheet.** Nothing that needs a keyboard is shown without one: no key hints, no status bar, no Vim mode.

- **Text, not icons**, in one short list. No activity bar, no bottom panel, no new top-bar or status-bar buttons (#135). Places hides with `⌘B`, the context panel with `⌘⌥B`; with both hidden it's a pure editor, the way it is now.
- **Single-letter keys are scoped**: they act only in the Feed and other lists, never in a note or a field. In a note, Vim stays Vim: `:archive`, `:trash`, `:feed`, and `Ctrl-O` back to the card you came from.
- **Go keys** (`g f` Feed, `g /` Search, `g d` Today, `g t` Tasks, `g c` Calendar, `g a` Archive, `g x` Trash, `g s` Sources, `g e` Extensions, `g ,` Settings) work outside text, like Linear's and Gmail's.
- **Vim's window keys move focus** between Places, the editor area and the context panel: `Ctrl-W h`/`l`/`w`.
- **Five keys to start** in the Feed (`j` `k` `↵` `e` `#`); the rest are there when you want them, and `?` lists them all.

## 6. Mobile first

The recommended model, designed from a phone (375px wide, touch, no hardware keyboard) and then grown. Every flow here works in [navigation-mobile.html](prototypes/navigation-mobile.html) with the device set to Phone.

### 6.1 The phone

```text
┌ Feed            Select  ✎ ┐   ┌ ‹  Launch plan      ◷  ⋯ ┐   ┌ Places ────────────────────┐
│ [All] Mine  Agents 4      │   │ Projects/Launch plan.md   │   │ Feed               4 new   │
│ -is:archived sort:edited  │   │                           │   │ Search · Today · Tasks     │
│ PINNED                    │   │ Launch plan               │   │ Calendar                   │
│ ┌ Launch plan   4 min ago┐│   │ Ship the beta on Oct 20.  │   │ PINNED                     │
│ │ Claude · Added risks…  ││   │ ☐ Record the demo  Oct 7  │   │ Launch plan · A feed for…  │
│ │ ☐ Record the demo      ││   │ ☐ Draft the changelog     │   │ SAVED SEARCHES             │
│ └────────────────────────┘│   │                           │   │ Agent edits this week   6  │
│ ⤓ Archive ◀── swipe ──▶ ⌫ │   │ Tap the text to edit.     │   │ Sources ● Archive 4        │
│ ┌ 2026-10-05   22 min ago┐│   │                           │   │ Trash 4 · Extensions       │
│ └────────────────────────┘│   │                           │   │ Settings                   │
├───────────────────────────┤   ├───────────────────────────┤   │ Kept for wider screens:    │
│ Feed Today Cal Search ☰   │   │ ☐ • ⇥ ⇤ │ H [[ due @ │ ↶ ⌄│   │ 3 tabs and a window beside │
└───────────────────────────┘   └───────────────────────────┘   └────────────────────────────┘
        The Feed                 A note, editing toolbar          The Places sheet
```

- **Bottom bar:**
  - Three places from `places.json`'s `bar` (Feed, Today and Calendar by default; "Customize the bottom bar…" at the end of the Places sheet changes them, as Linear Mobile does).
  - Then **Search** and **Places**. Places opens the Places list as a sheet: the same list the desktop shows as a sidebar.
  - The bar hides while you edit.
- **Top bar:** the place's name, then the actions for that place. In the Feed that's Select, for picking several, and ✎ for a new note. In a note it's back, the title, ◷ for views about the note, and ⋯ for its menu.
- **Filter chips** under the top bar: All, Mine and Agents in the Feed, with the agent count.
- **The query line** under the chips says what the list is, as on the desktop: nothing hidden.
- **No status bar, no tabs, no Vim indicator** on a phone. Save state shows only when something's wrong ("Not saved: offline"), as a line under the top bar.

### 6.2 The Feed and triage by touch

| Gesture | In the Feed | In Archive | In Trash |
| --- | --- | --- | --- |
| Swipe right, past 42% of the width | Archive | Unarchive | Restore |
| Swipe left, past 42% | Trash | Trash | Delete forever (asks first) |
| Short swipe, 64px or more | Shows the action's button; tap it to do it | same | same |
| Tap | Open the note | Open | Look inside (a sheet with Restore and Delete forever) |
| Tap a checkbox | Tick the task | same | — |
| Long-press, or Select | Select; the bottom bar becomes Cancel · Pin · Archive · Trash | same | — |

- **Undo** is a snackbar ("Archived 'Reading list' · Undo") for five seconds. After that it's in History like any change, so `u`, ⌘Z and History all reach it.
- **Colours say what a swipe will do** before you let go, as in Gmail: green for archive, red for trash. The colour brightens once letting go will act.
- **Settings:** `feed.swipe.right` and `feed.swipe.left` take `archive`, `trash`, `pin` or `none`, as Gmail's do. The defaults follow Apple Notes and Bear: safe on the right, destructive on the left.
- **Edge swipes:** a swipe must start at least 24px in from the screen's edge, so it never fights the system's back gesture.
- **Pull to refresh isn't needed**, since the Feed is live. New changes while you're scrolled down show a "↑ 2 new changes" pill.

### 6.3 Search

- **Full screen.** The field is focused, so the on-screen keyboard is up, with Cancel beside it.
- **Filter chips** under the field: Archived, Pinned, Agents, Mine, This week, Events, Tasks, Trash. Tapping one **writes its filter into the query** (`from:agent`) and tapping again removes it, so the query stays plain text you can read, edit and save.
- **Results** in sections: Notes (with the matching line), Tasks, Events, Contacts, Commands.
- **See all as a list** at the end opens the results as a list of cards, and **Save** in its top bar puts it in Places. A phone has no `⌘↵`.
- **Commands** come from typing `>` or from a place's ⋯ menu, since there's no `⌘⇧P` without a keyboard.

### 6.4 Opening and editing a note

**Opening:**
- Tapping a card opens the note full screen, drawn as live preview.
- Back (‹, or the system's back gesture) returns to the same card.
- **Opening a note replaces the preview tab**, as the desktop already does, so using a phone never piles tabs into a layout.

**Editing:**
- **Tap the text to edit** at that spot. Tasks' checkboxes and event chips stay tappable without entering edit mode.
- A **keyboard toolbar** sits just above the on-screen keyboard (placed with `visualViewport`). Its buttons come from extensions:
  - Tasks: ☐ task, `due:`
  - Lists: • bullet, ⇥ indent, ⇤ outdent. These stand in for Vim's `>>` and `<<`.
  - Calendar: @ link an event
  - Core: heading, `[[` link, undo, hide the keyboard
- It scrolls sideways when there are more buttons than fit, as Obsidian's does. Long-pressing a button says which extension added it.
- **Done** ends editing.

**The ⋯ menu** is an action sheet: Pin, Archive, History and links…, Copy link, Open in a new tab, Open beside, and Move to Trash. The two that need room are shown greyed with why ("needs a screen 600px wide"), not hidden.

### 6.5 Calendar and other data sources

- **Calendar on a phone** is an agenda by day. The header says where the events come from ("Google Calendar · Work, Personal · synced 3 min ago").
- **Tapping an event** opens a sheet with its time, place, calendar and address, the **notes that link here**, **Make a meeting note**, and **Copy link**.
- **Wider:** at medium width Calendar shows 3 days; at expanded and above, the agenda sits beside the selected event's details.
- **Sources** is in the Places sheet: a row per source with its status and a Sync button. A source that needs reconnecting puts a dot on Places in the bottom bar.
- **Contacts** appear in search (`type:contact`) and as chips. They need no place of their own.

### 6.6 Trash on a phone

- **Each row** says when the note was deleted, by whom, and how long it has left, as a bar plus "4 days". It turns red in the last three days.
- **Swipe right** restores the note with its history.
- **Swipe left** asks, in a sheet, before deleting forever.
- **Tap** shows the last version, read-only, with Restore and Delete forever.
- **Empty** is in the top bar, and it asks first too.

### 6.7 Where extensions' views go on a phone

There's no separate "mobile panel" concept. Every contribution has a place at every size:

| Contribution | Phone | Tablet | Desktop |
| --- | --- | --- | --- |
| A **place** (Calendar, Tasks, Word count's page) | A row in the Places sheet; can be put on the bottom bar | Places sheet from the left, or the sidebar | The Places sidebar |
| A **context view** (History, Links, Agenda, Word count) | A bottom sheet from the note's ◷ button, with a switcher across its top; drag up for full height, down to close | A side sheet from the right | The docked context panel (large width) |
| A **command** | Search with `>`, and ⋯ menus | same, and `⌘K` with a keyboard | `⌘K`, `⌘⇧P`, keys |
| A **toolbar button** (new: `contributes.toolbar`) | The keyboard toolbar while editing | same, when touch is used | Not shown with a keyboard and no touch |
| An **embed** | Quiet in cards; in a note it draws, and a heavy one (html-app) waits for a tap to run | Draws | Draws |
| A **status bar item** | Not shown; where it matters it becomes a dot on a place (Sources) or a line in the top bar (a running timer) | same | The status bar |

### 6.8 How it grows

The same model at every width. A layout is windows, and the width decides how many show at once.

| | **Compact**, under 600 (phones) | **Medium**, 600–839 (tablets in portrait) | **Expanded**, 840–1199 (tablets in landscape, small laptops) | **Large**, 1200 and over |
| --- | --- | --- | --- | --- |
| Places | Bottom bar, and a sheet from below | Bottom bar, and a sheet from the left | A sidebar, `⌘B` or ☰ hides it | Sidebar |
| A list and a note | One at a time: the note covers its list | One at a time | **Side by side** (two windows) | Side by side, and a third window if you open one beside |
| Tabs | None | Over the note | Over the note | Over each window |
| Views about the note | Bottom sheet | Side sheet | Side sheet | **Docked context panel** |
| Search | Full screen | Full screen | Centered dialog | Centered dialog |
| Status bar | None | None | With a keyboard | With a keyboard |
| Keys and Vim | **Whenever a keyboard is found**, at any width | same | same | same |

**What changed from the first draft's desktop layout.** The Feed no longer opens as a tab with notes as other tabs. On expanded screens and wider, it's a list **beside** the note, which was the first draft's `o` (open beside), made the default. On a laptop that's the familiar three columns: Places, the list and the note. `j`/`k` moves through the list and the note beside it follows, like a mail client's reading pane. Everything else in the first draft stands: Places, the context panel, queries, archive and trash.

## 7. Extensions that depend on the device

Some extensions don't make sense everywhere: Vim without a keyboard, tabs on a phone, splits in a narrow window. How should an extension say where it applies, and how do you see and change that?

### 7.1 Four ways to say it

| | **A. Device class** | **B. Expressions** | **C. Capabilities it needs** (recommended) | **D. Code adapts, nothing declared** |
| --- | --- | --- | --- | --- |
| Looks like | `"platforms": ["desktop"]` (Obsidian's `isDesktopOnly`) | `"when": "keyboard && width >= expanded"` (VS Code's `when`) | `"requires": { "keyboard": true }` | `if (ctx.device.has("keyboard")) …` |
| iPad with a keyboard gets Vim | No | Yes | Yes | Yes |
| A narrow desktop window drops splits | No | Yes | Yes | Yes |
| A phone with a Bluetooth keyboard gets keys | No | Yes | Yes | Yes |
| The Extensions view can say why it's off | "Desktop only", which is vague | Has to explain an expression | **"Needs a keyboard"** | Can't: nothing is declared |
| Known before the code runs (ADR 0006) | Yes | Yes | Yes | No |
| Can be wrong about a device | Often: the web can't tell a tablet from a laptop, and iPadOS Safari says it's a Mac | Rarely | Rarely | Rarely |
| Cost | Least | An expression language to parse, check and explain | A small fixed vocabulary | None, but it hides decisions |

**C** is the recommendation, with **D's API for adapting inside an extension**. `requires` says when an extension, or one of its contributions, is off. `ctx.device` lets code that's on change how it draws: Calendar shows an agenda on a phone, and Boards drags by long-press on touch. B's power isn't needed while the vocabulary is this small, and an AND of named needs reads as a sentence. If it ever needs an OR, B can come later on top of the same names.

### 7.2 The vocabulary

Three capabilities. A small, closed set that the Extensions view can put into words.

| Capability | Values | How the app knows | Changes while open? |
| --- | --- | --- | --- |
| `keyboard` | `true` | Assumed on a device with a fine pointer that hovers (a desktop). Elsewhere, true the first time a key is pressed outside a text field, or a key an on-screen keyboard doesn't send (Escape, Tab, arrows, ⌘ or Ctrl chords) arrives. Remembered for the device. | Turns on when first seen; doesn't turn itself off. A tablet whose keyboard is detached keeps it until you say otherwise. |
| `width` | `compact`, `medium`, `expanded`, `large` (Material's classes) | The window's width: 600, 840 and 1200px | Yes, live: rotating, resizing, iPad Split View |
| `pointer` | `fine` | `any-pointer: fine`: a mouse or trackpad anywhere | Yes, live |

`touch` isn't a requirement, since nothing should need it; it's a fact `ctx.device` reports for adapting, from `any-pointer: coarse`.

**Detecting a keyboard is a guess**, because the web gives no direct way. The app is open about it:
- **Settings › This device** says what the app thinks and why: "Keyboard: yes, because a key was pressed outside a text field".
- One switch corrects it: Keyboard set to Auto, Yes or No.
- The first time one is found, a snackbar says so: "Keyboard found: Vim and shortcuts are on here."

### 7.3 The cases

What each declares, and whether it's on, on six devices:

| Case | Declares | Phone | Phone + Bluetooth keyboard | Tablet, portrait | Tablet + keyboard, landscape | Laptop | Laptop, narrow window |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Vim** | `requires: { keyboard: true }` | Off | On | Off | On | On | On |
| **Tabs** (Workbench) | `layout.tabs` `requires: { width: "medium" }` | Off, kept | Off, kept | On | On | On | Off, kept |
| **Splits** (Workbench) | `layout.splits` `requires: { width: "expanded" }` | Off, kept | Off, kept | Off, kept | On | On | Off, kept |
| **Command bar** | Nothing: it's core | Full-screen search; commands with `>` | `⌘K` too | Full screen | Dialog, `⌘K` | Dialog | Full screen, `⌘K` |
| **Keyboard shortcuts** (every extension's keybindings) | Keybindings need a keyboard by definition | Off: no hints anywhere | On | Off | On | On | On |
| **Kanban drag** (Boards) | Nothing; adapts | Long-press a card to drag; ⋯ › Move to… | same, and Alt+arrows | Long-press | Drag | Drag | Drag |
| **html-app embeds** | Nothing for the extension; an embed may say `minWidth` | Draws on tap ("Tap to run") | same | Draws | Draws | Draws | Draws unless its `minWidth` is wider: "Needs a wider screen · Run anyway" |
| Lists | Nothing; adapts | ⇥ ⇤ on the keyboard toolbar | `>>` `<<` with Vim | Toolbar | Keys | Keys | Keys |
| Calendar | Nothing; adapts | Agenda | Agenda | 3 days | Agenda beside event | Agenda beside event; week in the full view | Agenda |

**"Kept"** means the layout still has those tabs and windows; they come back when there's room (7.6).

### 7.4 Seeing why

Nothing may be hidden, so an extension or contribution that's off on this device is still listed, with why:

- **The Extensions view** gives each row a line for this device: "On", "Off on this device · needs a keyboard", or "On here · you turned it on; it needs a keyboard". The extension's page lists its `requires` beside what this device has. A box at the top describes the device: "Phone · compact width (375px) · touch · coarse pointer · keyboard: no (no key pressed yet)".
- **Menus keep items that are off**, greyed with the reason: "Open beside · needs a screen 1200px wide". Tapping one says the same in a snackbar.
- **Layout that's kept** shows as "3 tabs kept" in a note's top bar on a tablet, and under "Kept for wider screens" in the Places sheet on a phone.
- **Settings › This device** shows the device's file.

### 7.5 Overriding

- **Per device, per extension:** Auto, On here, Off here, in the Extensions view.
  - **On here** beats a requirement. You're told what it needs, and it runs anyway: Vim on a phone, for when you'll attach a keyboard.
  - **Off here** turns off something this device could run. For example, Vim on the tablet you hand to someone else.
- **Per device, the keyboard guess:** Auto, Yes or No.
- **Everywhere:** `extensions.disabled` in settings, as now.

**Precedence:**
1. `extensions.disabled`: off everywhere.
2. This device's override.
3. `requires` checked against this device.
4. On by default.

**Where it's kept:** each device has a folder, `.common-ink/users/<you>/devices/<id>/`, made the first time a browser signs in. The id is random and kept in that browser. `device.json` in it holds what was seen and your overrides:

```json
{
  "name": "iPhone · Safari",
  "lastSeen": "2026-10-05T09:12",
  "seen": { "width": "compact", "pointer": "coarse", "touch": true, "keyboard": false },
  "keyboard": "auto",
  "extensions": { "vim": "on" }
}
```

It's a file with history like any other, so you and your agents can read it. Settings › Devices lists your devices with when each was last seen, and can forget one.

### 7.6 Layout across devices

Today `layout.json` is one file for the workspace, so every browser shares one set of windows and tabs. With a phone in the picture that breaks: opening a note on the phone would move the laptop's tabs while you watch.

- **Recommendation: a layout per device**, in that device's folder (`devices/<id>/layout.json`).
  - **A new wide device** starts from the layout of the wide device you used last.
  - **A phone keeps only what it needs:** the place it was on and the note open over it.
  - **Continuing where you were** comes from the Feed. The note you just edited on your phone is at the top of the Feed on your laptop, by its last change.
- **Within one device, width changes never close anything.**
  - Narrow a laptop window, rotate a tablet, or use iPad Split View: windows that don't fit are **suspended**. The focused one shows, and the rest stay in the layout, unchanged.
  - Widen it and they're back where they were.
  - The layout file is written only when you change the layout, never because the window got narrower.
- **Tabs on a narrow device** are kept the same way. Opening a note replaces the preview tab, so no tabs pile up.

The alternative is to keep one shared layout and accept that devices move each other's tabs. It's simpler, and it's how v2 works today. That's decision 13.

### 7.7 Manifest and API

**Manifest.** `requires` can go on the extension or on any contribution: commands, views, places, embeds and toolbar buttons. Keybindings need a keyboard by definition.

```json
{
  "id": "vim",
  "requires": { "keyboard": true }
}
```

```json
{
  "id": "workbench",
  "contributes": {
    "layout": [
      { "id": "tabs", "title": "Tabs", "requires": { "width": "medium" } },
      { "id": "splits", "title": "Windows side by side", "requires": { "width": "expanded" } }
    ],
    "commands": [
      { "command": "workbench.splitRight", "title": "Open beside", "requires": { "width": "expanded" } }
    ]
  }
}
```

```json
{
  "id": "lists",
  "contributes": {
    "toolbar": [
      { "command": "lists.indent", "label": "⇥", "title": "Indent" },
      { "command": "lists.dedent", "label": "⇤", "title": "Outdent" }
    ]
  }
}
```

**`ctx.device`**, for code that adapts:

```ts
ctx.device.has("keyboard");         // true or false
ctx.device.width;                   // "compact" | "medium" | "expanded" | "large"
ctx.device.atLeast("expanded");     // true or false
ctx.device.pointer;                 // "fine" | "coarse"
ctx.device.touch;                   // true or false
ctx.device.onChange((device) => {}); // width, pointer or keyboard changed
ctx.device.why("keyboard");         // "a key was pressed outside a text field"
```

**Lifecycle:**
- **An extension whose requirements aren't met doesn't start.** Its contributions are listed but greyed, with the reason.
- **When they become met**, for example when a keyboard is found:
  - A sandboxed extension starts at once.
  - A trusted one that changes editors, like Vim, is added to open editors through a CodeMirror compartment, so no reload is needed.
- **A contribution whose width requirement stops being met is suspended, not stopped.** Its code keeps running and its UI is put away until there's room again. A timer keeps counting, and a rotation loses nothing.
- **The test levers** gain `?device=phone|tablet|laptop` and the probe gains `--device`, so tests and Previews can stand in for a device, as the prototype does.

## 8. Three navigation models

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
- *On a phone:* the activity bar becomes a row of icons at the bottom; a container's views cover the editor; the secondary side bar and bottom panel have nowhere to go. It works, but it's a desktop layout squeezed down (try the prototype at phone width).
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
- *On a phone:* the most natural of the three: a Feed and a search bar are already a phone app. But with no Places, Archive, Trash and extensions' places are reachable only through search.
- **Prototype:** the recommended prototype with Places hidden (`⌘B`) is this model.

### Model C: Places and the Feed (recommended)

Places on the left as one short text list; every place opens in the editor area; context views on the right; one search bar; every list a query. Sheets and a bottom bar on a phone, a sidebar and columns when wider. Described in full in sections 6, 7 and 9.

- **Prototype:** [navigation-mobile.html](prototypes/navigation-mobile.html), at every size; [navigation-places.html](prototypes/navigation-places.html) for the desktop's keys in depth.

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
| On a phone | Icons at the bottom; views cover the editor | Natural, but little to browse | Bottom bar, Places sheet; the same lists |
| Grows to desktop | Is the desktop | Stays one column | Sheet becomes sidebar; columns appear |
| Cost to build | High | Low | Medium |

## 9. Recommended model: Places and the Feed

### 9.1 Information architecture

The phone layout is in [6.1](#61-the-phone) and how it grows in [6.8](#68-how-it-grows). This is the large width with a keyboard: Places, the list, the note, and the context panel.

```text
┌ Places ──────────┬ Feed ───────────────────────┬ Launch plan │ Reading list ─────┬ History  Links  Agenda ┐
│ Feed      3 new  │ [All] Mine  Agents 3        │                               │ Launch plan            │
│ Search           │ -is:archived sort:edited    │ Launch plan                   │ Claude  +12 −3         │
│ Today            │ PINNED                      │ Ship the public beta on       │ 4 min ago · Added a    │
│ Tasks            │ ┌ Launch plan   4 min ago ┐ │ Oct 20. Agents keep the       │ risks section          │
│ Calendar         │ │ Claude · Added risks…   │ │ checklist current.            │ You  +6 −0             │
│                  │ │ ☐ Record the demo Oct 7 │ │                               │ 2 days ago             │
│ PINNED           │ └─────────────────────────┘ │ This week                     │                        │
│ Launch plan      │ TODAY                       │ ☑ Freeze the onboarding copy  │                        │
│ A feed for notes │ ┌ 2026-10-05   22 min ago ┐ │ ☐ Record the demo video Oct 7 │                        │
│ SAVED SEARCHES   │ │ ◷ Timer 25m             │ │                               │                        │
│ Agent edits…  6  │ └─────────────────────────┘ │                               │                        │
│ Sources  ●       │                             │                               │                        │
│ Archive 4        │                             │                               │                        │
│ Trash 4          │                             │                               │                        │
│ Extensions       │                             │                               │                        │
│ Settings         │                             │                               │                        │
├──────────────────┴─────────────────────────────┴───────────────────────────────┴────────────────────────┤
│ NORMAL  Saved                                    j/k · ↵ open · e archive · # trash · p pin · u undo     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
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

### 9.2 Key flows

All five work in the prototypes, by touch in [navigation-mobile.html](prototypes/navigation-mobile.html) and by keys in both it (set to a device with a keyboard) and [navigation-places.html](prototypes/navigation-places.html).

**Triage the Feed.** `g f` (or click Feed). `j`/`k` through cards; the focused card shows its keys underneath. `e` archives with a toast "Archived 'Reading list' · a change to archive.json · Undo `u`" and the card slides out. `#` sends one to Trash. `p` pins (it jumps to Pinned). `x` on several, then `e`, archives them in one change. `o` opens the note beside the Feed; `j`/`k` then change what's beside, like a mail client's reading pane. `Tab` to Agents to see only what agents did; the purple dots go as you look. When the Feed is empty: "Inbox zero for notes." *By touch:* Feed on the bottom bar; swipe right to archive, left to trash, Undo on the snackbar; long-press then Pin, Archive or Trash for several; tap to read, back to return to the same card.

**Find a note.** `⌘K`, type `launch`. Notes whose titles match come first, then ones whose text matches with the line shown and the words marked; tasks, events and contacts in their own sections. Add `in:Projects/` (Tab completes it). `↵` opens. Or `Tab` for actions and `e` to archive it without opening. Or `⌘↵` to see all results as cards, and `⌘S` to save them as a place. *By touch:* Search on the bottom bar; type, tap chips to add filters; tap a result, or See all as a list and Save.

**Open a calendar event.** `⌘K`, type `dentist`. The event is under Events with its day and time. `↵` opens Calendar at that day with the event selected and its details below: where, which calendar, "Notes that link here" and `n` to make a meeting note. `↵` on the event opens the note that links to it. (In a note, clicking an event chip does the same.) *By touch:* Search, `dentist`, tap the event: a sheet with its details, the notes that link to it, and Make a meeting note.

**Restore from Trash.** `g x`. Each row says when it was deleted, by whom, and how long it has left, with a bar. `↵` shows the last version, read-only. `r` restores it: "Restored 'Untitled 3' to Untitled 3.md, with its history". `D` deletes one forever after asking; `⌘⇧⌫` empties Trash after asking. *By touch:* Places › Trash; swipe right to restore, left to delete forever (it asks), or tap to look inside.

**Add an extension's panel.** `g e`, select Word count in the Catalog, `↵` to install. Its row says what it adds ("Panel: Word count") before anything runs. It appears in the context panel's switcher and opens there. `Ctrl-W l` to the panel, `m`: "Add to Places", "Open as a tab" or "Close the panel". Adding to Places writes `places.json`, and it's undoable like any change. *By touch:* Places › Extensions › Install; its view appears in the note's ◷ sheet, and its place (if it has one) in the Places sheet, ready for the bottom bar.

### 9.3 Keyboard map

With a keyboard, at any width (a phone with a Bluetooth keyboard included). Without one, none of this shows.

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

### 9.4 Data model

New files, all JSON with a schema, all in history:

| File | Holds | Written by |
| --- | --- | --- |
| `.common-ink/archive.json` | `{"archived": [paths, sorted]}` | archive and unarchive operations |
| `.common-ink/pins.json` | `{"pinned": [paths, in order]}` | pin and unpin |
| `.common-ink/places.json` | `{"order": [place ids], "hidden": [ids], "saved": {"name": "query"}}` | Places, and saving a search |
| `.common-ink/users/<you>/feed.json` | `{"seenThrough": <revision>}` | leaving the Feed (only if decision 17 is yes) |

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

**Should pins and archive be per person?** Today a workspace is one person, so they're workspace files. When workspaces are shared, pins become per person (`.common-ink/users/<you>/pins.json`, as v1's stars were), and archive stays shared. That's decision 16.

### 9.5 History and undo, together

- `u` right after a triage undoes it: the change to `archive.json`, `pins.json`, or the delete. It's the same undo as everywhere (ADR 0002).
- History's filter by author ("undo what the agent did") also covers an agent archiving or deleting notes.
- Trash's Restore is undo of one specific change, so it works even after many other changes.
- Purge is the one thing undo can't reach, which is why it asks, can't be done by agents, and leaves a line.

### 9.6 Extension API

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
- **`ctx.places.reveal(id)`, `ctx.views.move(id, location)`**: so an extension's command can open its place or move its view; the user's choice in the layout wins.
- **`requires`** on the extension and on any contribution, **`contributes.toolbar`** for the keyboard toolbar, **`contributes.layout`** for the Workbench's parts, and **`ctx.device`**: see [7.7](#77-manifest-and-api).
- **Context views** are drawn the same way wherever they show (sheet, side sheet, docked panel); a view gets its width class from `ctx.device` and is told when it changes.

### 9.7 Risks

- **Purging edits history**, which ADR 0002 treats as the source of truth. It's per file, and history is per file, so it's contained, but it needs a property test: purge any path at any point and every other file's history replays the same.
- **Full-text search** is new infrastructure (FTS5 in the Durable Object, kept in step in the same transaction as writes, as the records index is).
- **Live tasks in cards** write from a list, not an editor; they must merge like any edit (ADR 0002 already merges).
- **Keyboard detection is a guess** (7.2). A wrong guess shows key hints on a phone or hides Vim on a tablet; Settings › This device and the Extensions view make it visible and one switch fixes it.
- **Gestures can clash**: a swipe on a card against the system's back swipe (start 24px in from the edge), against a table or code block that scrolls sideways inside a card (cards clip them, so they don't scroll there), and against embeds (quiet in cards).
- **Per-device files** add history: device files change rarely, but a per-device layout changes as often as today's `layout.json` does, once per device.
- **History noise**: every triage key is a change. Changes to `.common-ink/` are already in history (layout.json is); History's filter should hide them by default.

## 10. Build plan

Pull-request sized, mobile first. Each ships something you can use, with its own Preview and a "Try this PR" note. Each is checked on a phone (`--device phone`) as well as a desktop.

1. **Devices and capabilities.** In the core:
   - `ctx.device`: width class, pointer, touch, and keyboard detection.
   - The device folder (`devices/<id>/device.json`) and Settings › This device.
   - `requires` on extensions and contributions, checked and explained in the Extensions view, with per-device overrides.
   - Levers: `?device=` and the probe's `--device`.
2. **Vim and the Workbench declare what they need.**
   - Vim declares `requires: { keyboard: true }`. It turns on live when a keyboard is found, through a compartment.
   - Tabs and splits declare their widths. Windows that don't fit are suspended, and the layout is kept.
   - Layout per device (if decision 13).
   - Keybinding hints show only with a keyboard.
3. **The phone shell.**
   - The bottom bar (`places.json`'s `bar`), the Places sheet (at first: All notes, the existing views, Extensions, Settings), and full-screen stack navigation with back.
   - The viewport, safe areas, and `visualViewport` for the keyboard.
   - Sheets for context views (`views.context`).
   - `contributes.toolbar` and the keyboard toolbar, with Lists' and Tasks' buttons.

   After this step v2 is usable on a phone.
4. **Query library.** `common-ink/query`: the parser and matcher for words, `is:`, `in:`, `from:`, `type:`, `edited:` and `has:`, with property tests. No UI.
5. **Full-text index and search.**
   - FTS5 in the workspace's Durable Object, updated in the write transaction.
   - The `search` operation over MCP and the CLI.
   - The search screen: full screen with chips on a phone, a dialog with `⌘K` and filter completion on wider screens.
   - Providers from extensions (`contributes.search`): events, contacts, tasks, settings.
6. **Archive.**
   - `archive.json`, and the `archive` and `unarchive` operations.
   - The ⋯ menu item, `:archive` and `⌘⇧E`.
   - The banner on an archived note, `archived` in `list_files`, and archived notes last in search.
7. **Trash and Restore.**
   - The Trash place, with swipes on touch and `r`/`D` with keys.
   - Restore as undo of the delete.
   - "In Trash · Restore" on links to a deleted note.
8. **Purge and retention.** `purge`, Delete forever, Empty Trash, the daily alarm, `trash.retentionDays`, and the property test.
9. **The Feed, touch first.**
   - Cards, date groups, pinned first, pages as you scroll, the new-changes pill.
   - Swipes with the `feed.swipe.*` settings, long-press to select, the undo snackbar.
   - Quiet embeds with `summary`.
   - Then the keys: `j`/`k`/`↵`/`e`/`#`/`dd`/`p`/`x`/`u`.
10. **Places on wide screens.**
    - The Places sidebar, the list beside the note (two windows), `⌘B` and the go keys.
    - `contributes.places`, so Daily notes, Tasks and Calendar add theirs.
    - Pins (`pins.json`) and saved searches.
11. **Agents in the Feed.** All, Mine and Agents; summaries; grouping an agent's runs of changes; the diff; unseen dots (if decision 17).
12. **The docked context panel** at large widths, `m` to move a view, and Links as a default extension.
13. **Embeds by device**, after living with step 9. Live on the focused card with a keyboard (`feed.liveEmbeds`); "Tap to run" for heavy embeds on phones; `minWidth` for html-apps.
14. **Status line:** a word count for the note in focus and an online/offline state on wider screens (decision 23). No bottom panel until something needs one.

Steps 4 to 8 don't depend on the navigation decision and can go in any order after step 1. Steps 1 to 3 are the mobile foundation: everything after them is built and checked on a phone first.

## 11. Testing with you

There's no one else to recruit, so the plan is four short sessions with you, using the prototypes first and Previews later. Each task has a goal you can check yourself; time it if you like.

### Session 1: on your phone (20 minutes, now)

Open [navigation-mobile.html](prototypes/navigation-mobile.html) on your phone: from the published study, or the file from the repo. Use it one-handed, with no keyboard.

| # | Task | Success looks like |
| --- | --- | --- |
| 1 | Triage the first ten cards: archive five, trash two, pin one | Under 60 seconds; no swipe did the wrong thing, or Undo fixed it at once |
| 2 | Archive three notes in one go | You found long-press or Select without help |
| 3 | Find the note about trash retention | Under 15 seconds |
| 4 | Open tomorrow's dentist appointment and the note that links to it | Under 20 seconds |
| 5 | Restore "Untitled 3" from Trash | Under 15 seconds; you found Trash in Places |
| 6 | Add a task to today's note with a due date, using the toolbar | You didn't have to type `- [ ]` or `due:` |
| 7 | Put Tasks on the bottom bar in place of Calendar | Under 30 seconds |
| 8 | See why Vim is off on your phone | You found it in Extensions, and the reason made sense |

### Session 2: the desktop and the alternative (30 minutes)

Open [navigation-mobile.html](prototypes/navigation-mobile.html) set to Laptop, and [navigation-workbench.html](prototypes/navigation-workbench.html), side by side. Do the tasks without the mouse. Then set the first to "Laptop, narrow window" and to "Tablet + keyboard", and look at what changes.

| # | Task | Success looks like |
| --- | --- | --- |
| 1 | Get the Feed down to what you want to keep: archive 5, trash 2, pin 1 | Under 90 seconds, no mouse |
| 2 | Find what agents changed today | You reach Agents or `from:agent` without the `?` sheet |
| 3 | Find the note about trash retention | Under 15 seconds |
| 4 | Restore "Untitled 3" | Under 15 seconds |
| 5 | Save "notes in Projects that mention launch" as a place | Under 20 seconds |
| 6 | In the narrow window, find where your tabs went | You found "kept", and believed they'd come back |

[navigation-places.html](prototypes/navigation-places.html) has more of the keyboard flows (the `c` diff, rows, the context panel's `m` menu) if you want to go deeper.

Questions after sessions 1 and 2:

1. Which one did you want to keep using, on each device? Why?
2. Did the cards tell you enough to archive without opening the note?
3. Did the swipe directions feel right? Did you ever swipe the wrong way?
4. Did the phone and the laptop feel like the same app?
5. Was anything hidden that you expected to see, or anything shown that felt like clutter?
6. When something was off on a device (Vim, tabs, Open beside), did the reason make sense, and would you want to turn it on anyway?

### Session 3: a week on a Preview, phone and laptop (after build step 9)

Use the Feed as home on both for a week. Add a line to the day's journal when something annoys you. Measured from history, not memory:

- Triage actions per day on each device, and how many were undone within a minute. A high undo rate on the phone means a swipe is in the wrong direction or too easy.
- Restores from Trash. Each one means a delete was a mistake, or Trash was used as "later".
- How often you open Archive. Never means it's working; often means archive is being used as "later".
- Whether the keyboard was detected on the devices you have, and whether you had to correct it.

### Session 4: search (after build step 5)

Ten real lookups over a few days, on both devices, each noted with what you typed, whether the first result was right, and whether you used a filter or chip. Success: the first result is right for eight of ten.

## 12. Decisions

Decided on 2026-10-06. Three answers were left open; they take the recommendation, and they're marked.

**The model**

1. **Model:** C, Places and the Feed, mobile first.
2. **Name:** Feed.
3. **Places** are text: a sheet on phones, a sidebar on wide screens. No activity bar.
4. **On wide screens** a list sits beside the note. The Feed isn't a tab.

**Phones**

5. **Swipes:** right archives, left trashes. Both are settings.
6. **The bottom bar's places** by default: Feed, Today, Calendar.
7. **An installable web app (PWA) first.** A native shell only if the PWA hits a wall.

**Devices and extensions**

8. Extensions say what they need with **`requires`** (capabilities, not device types).
9. **Tabs** show from medium width (tablets in portrait).
10. **Keyboard detection:** assume one on desktops, detect it elsewhere and keep it once seen; Auto, Yes and No per device.
11. **Per-device overrides** ("On here", "Off here") live in the device file.
12. **Device files** in `.common-ink/users/<you>/devices/`, with history.
13. **Layout is per device**, and a new wide device starts from your last wide layout.

**The Feed, archive and trash**

14. An agent's edit **doesn't** bring an archived note back to the Feed; it shows under Agents, marked archived.
15. Archived notes are **shown last and marked** in search.
16. **Pins** are the workspace's now, and each person's once workspaces are shared.
17. **Unseen dots** for agents' changes: yes.
18. **Trash:** 30 days, as a setting (`trash.retentionDays`). Agents can't purge; only you can *(left open; the recommendation)*.
19. **Embeds in cards** are quiet: live on the focused card with a keyboard, and heavy ones wait for a tap on phones.
20. **Keys:** both `#` and `dd` trash; `p` pins *(left open; the recommendation)*.
21. **At start**, the place you were last on, on this device.
22. **No file tree** in Places. Folders are found with `in:` and saved searches.
23. **No bottom panel** until something needs one *(left open; the recommendation)*. Instead, the status line on wider screens gains a **word count** for the note in focus and an **online/offline** state. On a phone the status line stays hidden and offline shows only when something isn't saved.

**Also decided: standard icons.** Delete, archive and pin use the icons people already know: a trash can, an archive box and a pushpin (Lucide's `trash-2`, `archive` and `pin`), not arrows or keyboard symbols. Restore, undo and unarchive follow the same set.

## 13. Sources

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

Phones and devices

50. Gmail Help, Change your Gmail settings (swipe actions): https://support.google.com/mail/answer/6562?hl=en&co=GENIE.Platform%3DAndroid
51. Readwise, Reader Public Beta Update #2 (custom swipes): https://readwise.io/reader/update-feb2023
52. Readwise Docs, Changelog (shorter long swipe): https://docs.readwise.io/changelog
53. Things Support, Using Gestures: https://culturedcode.com/things/support/articles/2803582/
54. Apple Support, Use Notes on your iPhone, iPad and iPod touch (pin and delete by swiping): https://support.apple.com/en-us/118442
55. Bear FAQ, Pin notes and tags: https://bear.app/faq/pin-notes-and-tags/
56. Bear blog, Take action on multiple notes with the Drop Bar: https://blog.bear.app/2018/02/bear-tips-take-action-on-multiple-notes-with-the-drop-bar/
57. The Sweet Setup, The best notes app for iPhone and iPad: Bear (swipes on iOS): https://thesweetsetup.com/apps/the-best-note-taking-apps-for-ios/
58. Craft Help Center, Navigation: https://support.craft.do/en/introduction/navigation
59. Craft Help Center, Tab Management: https://support.craft.do/en/introduction/navigation/tabs
60. Linear changelog, Customize your navigation in Linear Mobile: https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile
61. Linear Mobile: https://linear.app/mobile
62. Obsidian Help, Mobile app: https://obsidian.md/help/mobile
63. Obsidian Developer Docs, Mobile development: https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development
64. Obsidian Developer Docs, PluginManifest (`isDesktopOnly`): https://docs.obsidian.md/Reference/TypeScript+API/PluginManifest
65. Material Design 3, Breakpoints (window size classes): https://m3.material.io/foundations/layout/applying-layout
66. Android Developers, Use window size classes: https://developer.android.com/develop/ui/views/layout/use-window-size-classes
67. MDN, `pointer` media feature: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/pointer
68. MDN, `any-pointer` media feature: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/any-pointer
69. MDN, VirtualKeyboard API: https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API
70. MDN, VisualViewport: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
71. VS Code, when clause contexts: https://github.com/microsoft/vscode-docs/blob/main/api/references/when-clause-contexts.md
72. Apple WWDC24, Elevate your tab and sidebar experience in iPadOS: https://developer.apple.com/videos/play/wwdc2024/10147/
73. Viewport resize behavior explainer (`interactive-widget`): https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md
