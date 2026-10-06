# Writing an extension

Built-in features are extensions on the same manifest and API anyone else's use (ADR 0006): see `web/src/extensions/`. An extension is a folder with two kinds of file:

- `extension.json`, the manifest: what the extension is, what it adds, when its code starts, and what it may ask for.
- Its code: `main` (default `index.js`), an ES module whose default export has `activate(ctx)`, plus any modules `main` imports from the same folder. Everything else it needs comes through `ctx`, or, for trusted extensions that change editors, from the libraries below.

A workspace extension's folder is `.common-ink/extensions/<id>/`, edited like a note and kept in history. The folder's name is the id. Install one from the Catalog in the Extensions view, or from where it's published with Install from URL, which copies its files in. Installing from a URL takes the id out of every trusted list first (the workspace's and each person's), so new code under an id someone trusted starts sandboxed, and the app says so. If a settings file that lists trusted extensions isn't valid JSON, the install waits until it's fixed. Trust you give is kept in your settings; Stop trusting takes the id out of yours and the workspace's.

## Libraries

Trusted code that changes editors needs CodeMirror, and it must be the app's own copy. An extension may import these by name, and nothing else outside its folder: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/language-data`, `@codemirror/commands`, `@codemirror/autocomplete`, `@lezer/highlight`, `@lezer/markdown`, `@replit/codemirror-vim`, `katex`, and the app's `common-ink/live-preview` (the live-preview mechanism tasks, markdown, tables and math use: `livePreview` for what a line draws, `blockPreview` for widgets that stand in for whole lines), `common-ink/describe`, `common-ink/keys`, `common-ink/editor-file` (the file an editor shows), `common-ink/files`, `common-ink/uploads`, `common-ink/icons` (the standard icons for a note's trash, archive and pin, and undoing them: `icon(name)`), `common-ink/query` (the query language: `parse`, `format`, `matches` and `select`, the `FILTERS` it knows, and `tokens` and `holds` for matching words the way search does), `common-ink/recurrence` (repeat rules: `rec:` tokens and RRULEs, their words and their days) and `common-ink/calendar` (events: their times in zones, occurrences, and edits of a series). In a workspace extension, the Worker points those imports at `/lib/<name>.js`, which hands over the app's instance. The list is `web/src/library-names.ts`.

## Where it runs

A workspace extension runs **sandboxed** unless you trust it: in a hidden iframe of its own, with an opaque origin and a policy that lets nothing connect out. It can't see the app's page, cookies or storage, and everything it does is a message to the app, which checks its manifest and your answers first. Its views are **webviews**: frames it writes HTML into, in the app's colours, with `commonInk.post()` and `commonInk.onMessage()` to talk to its code.

Built-ins and extensions you mark **trusted** (Trust… in the Extensions view) run in the app's page. They can also change note editors and draw views straight into the page. They can get around the permissions they declare, so trust only code you've read or wrote. Customize trusts the copy it makes, since you made it yours.

## Permissions

The manifest's `permissions` are the most an extension may ever ask for, each with why. The first time it asks, you see "Word count wants to read your notes · Count the words in the note on show", and choose Allow once, Always allow, or Don't allow. Your answers are kept in your settings, under `extensions.permissions`, and the Extensions view lets you change them. Built-ins have what they declare until you deny it. Every check and every network request shows in Extension activity, and a dot in the status bar shows while a request is in flight.

## The manifest

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "description": "A Word count view for the note on show.",
  "main": "index.js",
  "activationEvents": ["onView:wordCount", "onCommand:wordCount.show"],
  "permissions": {
    "files:read": { "paths": ["**"], "why": "Count the words in the note on show" }
  },
  "contributes": {
    "commands": [{ "command": "wordCount.show", "title": "Show word count" }],
    "keybindings": [{ "key": "Mod-Shift-c", "command": "wordCount.show" }, { "vim": "gC", "command": "wordCount.show" }],
    "menus": { "tabMenu": [{ "command": "wordCount.show" }] },
    "views": { "sidebar": [{ "id": "wordCount", "name": "Word count" }] },
    "configuration": {
      "title": "Word count",
      "properties": {
        "word-count.includeCode": { "type": "boolean", "default": false, "description": "Count words in code blocks too." }
      }
    }
  }
}
```

- **activationEvents.** `onStartup`, `onCommand:<id>`, `onView:<id>`, `onEmbed:<language>`. The extension's code starts the first time one happens. Everything the manifest declares is in place before that: its commands are in the command bar, its keybindings work, its views are listed, its settings are in the settings editor. Without activation events, an extension starts with the app.
- **contributes.commands, views and menus.** The code fills in what they do with `ctx.commands.register(id, run)` and `ctx.views.register(id, { render(el) })`. Registering one the manifest doesn't declare is an error.
- **contributes.keybindings.** A `key` like `"Mod-Shift-c"` (Mod is ⌘ on a Mac and Ctrl elsewhere, matched by the character typed) or a Vim normal-mode sequence like `"gC"`, which works while the Vim extension is on. A Vim key with `"operator": true` takes the place of Vim's operator of that key: Lists binds `>` and `<` so `>>`, `>j`, `>ip` and `>` on a selection move list items with their children. Settings can rebind keys.
- **contributes.configuration.** The extension's settings, as JSON Schema: `type`, `default`, `description`, `enum`, `minimum`, `maximum`, and `appliesAfterReload`. Their keys start with the extension's id. They get their own section in the settings editor, and `ctx.settings.get(key)` reads them.
- **permissions.** The most the extension may ask for, each with why. See ADR 0006 for the kinds and how asking works.

## The context

`ctx` is an `ExtensionContext` (`web/src/extension-api.ts`):

- `ctx.commands.register(id, run)`, `run(id)`, `all()`, `shortcut(id)`, and `keybindings()`: every binding in effect, with the Vim sequences extensions declare (the Vim extension maps those).
- **A sandboxed extension's calls have limits.** Each carries at most 2,000,000 characters' worth (as JSON), and together at most 10,000,000 characters' worth and 2,000 calls every 10 seconds. Past that a call is refused with the reason, so an extension reading many notes at once (more than about 1,700 in 10 seconds) has to wait and try again. A webview's message to its extension is held to the same size; one that's too big is dropped, with the reason in the webview's console.
- `ctx.statusBar.set(id, text, tooltip?)` shows text in a status bar item the manifest declares (`contributes.statusBarItems`: `id`, `alignment` left or right, `priority`, and a `command` a click runs). Empty text hides it.
- `ctx.views.register(id, { resolve(webview) })` draws a view as a webview: set `webview.html`, and `webview.post()` and `webview.onMessage()` talk to its page. Trusted extensions may use `{ render(el) }` to draw into the page instead. Also `provide(prefix, make)` for views made from their id (like History's `version:<rev>:<path>`), `show`, `toggle`, `refresh`, `open`.
- `ctx.commandBar.provide({ prefix, placeholder, items(query) })` adds a command bar provider. The bar picks the provider with the longest prefix the query starts with. Items may say their `section`, an `aside` (a few words at the row's end) and `dim`.
- `ctx.search.provide(type, { search(query, limit) })` answers a kind of result the manifest declares in `contributes.search.types`. `query` is already read with `common-ink/query`, without its `type:` filters; match its words with `matchesWords`, and find nothing for a filter your results don't have. Each result has a `title`, and may have a `path`, `detail`, `aside` and `dim`, and `run()` opens it. `ctx.search.find(text, limit, progress?)` searches as the search screen does, a section per kind, and `progress` hears the sections found so far. A sandboxed extension gets only what it could read itself: notes and tasks it may read (`files:read`), events with `data:calendar:read`, and its own kinds. `ctx.search.filterKeys()` are the filter keys extensions add, for `parse`. One kind of result has one provider, the first extension that declares it; a provider that takes longer than half a second is left out of that search. Tasks answers `type:task` and Calendar `type:event` this way.
- `ctx.files` lists, reads and writes files, each checked against `files:read` and `files:write`. Writes are changes in history by the extension, acting for you.
- `ctx.clipboard.read()` and `write(text)`, and `ctx.notifications.show(title, body)`, each checked against its permission.
- `ctx.media.session({ title, kind, el?, sticky?, play, pause, stop? })` says something plays, with the `media` permission: a `video` or `audio` it can play and pause, drawn in `el` if that's in a note's embed. It returns `{ id, set({ playing, title }), end() }`: call `set` as it starts and stops. The Media extension's mini player, the status bar and the media keys control the one played last (`ctx.media.current()`, `onChange`, `play(id)`, `pause(id)`, `stop(id)`, and `reveal(id)` to go to its note). A video playing in an embed floats in a small window while its note is out of sight, and docks when it's back; audio plays on unseen. The `media.whenHidden` setting picks `float`, `keepPlaying` or `pause`.
- `ctx.net.card(url)` gets a link's card (title, description, site, and its picture as a data: URL) the same way.
- `ctx.urlEmbeds.register(id, { render(el, { url, match }) })` draws a link alone on its line, for a URL embed the manifest declares (`contributes.urlEmbeds`: `id`, `title`, `pattern`, and the `frameHosts` it frames, which the page's policy allows only while the extension is on). The first pattern that matches draws it. Trusted extensions only.
- `ctx.data` reaches data sources' records (ADR 0007), such as calendar events: `status()` and `connect()`; `calendar.calendars()`, `events(from, to)` (each occurrence of a series, with its address), `event(address)`, `create(event)`, `update(address, change, scope)` and `remove(address, scope)`, where `scope` is `"this"`, `"following"` or `"all"` for an occurrence of a repeating event, and `onChange(fn)`; and `contacts.search(query)`. Reading asks for `data:calendar:read` or `data:contacts:read`, changing for `data:calendar:write`. A built-in's changes are yours; another extension's are by it, acting for you. A manifest names the data sources it shows in `contributes.dataSources` (`id`, `kind`, `title`).
- `ctx.net.fetch(url, init)` fetches through the Worker: only hosts the manifest declares and you've allowed, with no cookies or referrer, at most 1 MB. A sandboxed extension has no other way out.
- `ctx.layout` is the layout of windows and tabs: `get()`, `change(fn)` with `common-ink/layout`'s helpers, `close(group, index)`, `closeTabs(which)`, `isSaved(tab)` and `title(tab)`. `chrome({ window, tabs, divider, empty })` draws around the windows, as the Workbench extension does; one extension draws it, and it needs the `editor` permission. Things that open in a window carry `data-open` (the item as JSON) for chrome that drags them.
- `ctx.commands.menu(id)` lists the commands extensions add to a menu, such as `tabMenu`. A command in the `quickOpen` menu is listed in ⌘P with files, by its title without "Open" (Calendar's "Open calendar" is "Calendar").
- `ctx.workbench` opens files, says which file is focused and whether it has unsaved changes, splits a window (`split(direction, path?)`), reads and moves the focused window's tabs (`tabs()`, `moveTab(by)`), shows a notice, and says whether there's a place to go back or forward to (`canGo(by)`). Trusted extensions can ask before something that can't be undone with `confirm(title, text, yes)`, as Trash does before Delete forever.
- `ctx.embeds.register(language, provider)` draws an embed the manifest declares (`contributes.embeds`), with `activationEvents` `onEmbed:<language>`. A contribution says:
  - its `language` (its name), `title` and `description`
  - its `syntax`: `"leaf"` for one line with nothing to close (`::timer{duration=25m}`), `"container"` for markdown wrapped in `:::name{…}` … `:::`, or `"fence"` for code in a fenced block. Without it, an embed with a `body` is a fence and one without is a leaf.
  - its `arguments`, each with its `type` (`string`, `number`, `duration` or `boolean`), `description` and `default`, and for its settings form an optional `label`, `enum` (a choice), `presets` (values in one click) or `hidden: true` (an `id`, kept as it is)
  - its `body`, what a container's or fence's content holds

  The core draws each embed's toolbar: Settings, a form made from its arguments that writes them back into the markdown as your edit, and Edit markdown. The provider gets the `Embed`: its `language`, `syntax`, `args`, `body`, `note` and a `key` that names it (its note and `id` argument, or which embed of its kind it is). `{ resolve(webview, embed) }` draws it as a webview, in a quiet frame with Stop, as tall as its page unless an argument `height` says otherwise; trusted extensions may use `{ render(el, embed) }` to draw into the page. Give it `update(webview, embed)` (or `update(el, embed)`) too, and new arguments or a new body (its settings were saved, or its markdown changed) come to what it already drew, so its frame isn't reloaded; without it, the embed is drawn again. It draws again each time it shows: keep anything that lasts in the extension, keyed by `embed.key`. See docs/embeds.md for writing them into notes.
- `ctx.state.get()` and `set(value)` keep the extension's state in `.common-ink/extensions/<id>/state.json`, as changes by it in history, synced and kept across reloads. No permission needed.
- `ctx.changes.describe(fn)` puts words to changes in history, such as "Completed 'Pay rent' (due Oct 1)".
- `ctx.events.onSaved` and `ctx.events.onFocus` say when a file saved and when focus moved. A trusted extension can hear each change as it's recorded, by anyone, with `ctx.events.onChange(fn)`: its path and revision, and whether it deleted the file (`deleted`) or undid another change (`undoes`), as Trash does to know when to load again.
- `ctx.settings.get(key)` reads any setting in effect.
- `ctx.extensions.api(id)` is the API another extension offers: whatever its `activate` returned (as in VS Code). Asking starts it if it hasn't started. It's `undefined` if that extension is off, failed, sandboxed or not there, so the caller does without. Tasks asks Daily notes where daily notes are this way, so there's one definition.
- `ctx.util.fuzzyFilter`, `notePathFor` and `label` are the helpers the built-ins use.
- `ctx.editor.extend(extension)` adds a CodeMirror extension to every note's editor, and with `{ everywhere: true }` to every editor, settings and code too (as Vim does). `ctx.editor.focused()` is the focused editor. `ctx.editor.markdown(extension)` adds a `@lezer/markdown` extension to the language notes are parsed with: new syntax (GFM, math) or how code blocks parse. The core's markdown is CommonMark. They need the `editor` permission, and only trusted extensions get it.

## Customizing a built-in

In the Extensions view, Customize copies a built-in's folder into the workspace as a workspace extension with the same id, and opens its code. Built-ins written in TypeScript are copied as the JavaScript the app runs (Source shows the TypeScript). The copy is trusted, since you made it yours, and after a reload it runs in place of the built-in. Revert to built-in deletes the copy (one change per file, which undo can take back).

## The default extensions, and the Catalog

The core is the file store and sync, history, the layout, commands and the command bar, settings, the Extensions view, permissions, safe mode, and a plain editor with markdown highlighting and standard keys. On by default, as extensions: Workbench (tab bars, splits, dragging, borders and the tab menu), Vim, Live preview, GFM, Code blocks, LaTeX, Lists (outliner editing, bullets, numbers and folding), Daily notes, Tasks, Timers (timer, stopwatch and alarm embeds), Media (background noise and the mini player), Link embeds (videos, posts, music and link cards), History, Archive, Trash, Calendar, Contacts, Uploads, and the command bar's Search and Command list. Each loads only when one of its activation events happens, so it isn't in the app's first download.

The Catalog, at the bottom of the Extensions view, lists first-party extensions that aren't on by default (Word count, Boards, Pomodoro, HTML app), from `/catalog/index.json` (`web/public/catalog/`). Install copies one's files into the workspace, where it runs sandboxed, at once: a sandboxed extension needs no reload to start, and a note's blocks for its embeds draw. A block for an embed only an uninstalled Catalog extension draws offers to install it. Other catalogs plug in with the `extensions.catalogs` setting: the address of each one's `index.json`, read through the Worker's safe fetch. Their extensions are other people's code, installed at your own risk. An index is `{"name": "…", "extensions": [{"id", "name", "version", "description", "path"}]}`, where `path` is the extension's folder, relative to the index.

## Turning extensions off, and safe mode

Turn an extension off in the Extensions view, or with `"extensions.disabled": ["history"]` in settings. It takes effect after a reload, and the status bar says so until then.

An extension whose manifest is wrong, or whose code throws while starting, is marked Failed in the Extensions view with its error, and the rest carry on. A command, view or listener that throws later is caught and shown the same way. If a workspace extension breaks the app anyway, open it with `?safe=1`: only built-ins start.
