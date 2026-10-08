# Writing an extension

Built-in features are extensions on the same manifest and API anyone else's use (ADR 0006): see `web/src/extensions/`. An extension is a folder with two kinds of file:

- `extension.json`, the manifest: what the extension is, what it adds, when its code starts, and what it may ask for.
- Its code: `main` (default `index.js`), an ES module whose default export has `activate(ctx)`, plus any modules `main` imports from the same folder. Everything else it needs comes through `ctx`, or, for trusted extensions that change editors, from the libraries below.

A workspace extension's folder is `.common-ink/extensions/<id>/`, edited like a note and kept in history. The folder's name is the id. Install one from the Catalog in the Extensions view, or from where it's published with Install from URL, which copies its files in. Installing from a URL takes the id out of every trusted list first (the workspace's and each person's), so new code under an id someone trusted starts sandboxed, and the app says so. If a settings file that lists trusted extensions isn't valid JSON, the install waits until it's fixed. Trust you give is kept in your settings; Stop trusting takes the id out of yours and the workspace's.

## Libraries

Trusted code that changes editors needs CodeMirror, and it must be the app's own copy. An extension may import these by name, and nothing else outside its folder: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/language-data`, `@codemirror/commands`, `@codemirror/autocomplete`, `@lezer/highlight`, `@lezer/markdown`, `@replit/codemirror-vim`, `katex`, and the app's `common-ink/live-preview` (the live-preview mechanism tasks, markdown, tables and math use: `livePreview` for what a line draws, `blockPreview` for widgets that stand in for whole lines), `common-ink/describe`, `common-ink/keys`, `common-ink/editor-file` (the file an editor shows), `common-ink/files`, `common-ink/uploads`, `common-ink/query` (the query language: `parse`, `format`, `matches` and `select`, the `FILTERS` it knows, and `tokens` and `holds` for matching words the way search does), `common-ink/recurrence` (repeat rules: `rec:` tokens and RRULEs, their words and their days) and `common-ink/calendar` (events: their times in zones, occurrences, and edits of a series). In a workspace extension, the Worker points those imports at `/lib/<name>.js`, which hands over the app's instance. The list is `web/src/library-names.ts`.

## Where it runs

A workspace extension runs **sandboxed** unless you trust it: in a hidden iframe of its own, with an opaque origin and a policy that lets nothing connect out. It can't see the app's page, cookies or storage, and everything it does is a message to the app, which checks its manifest and your answers first. Its folder can't be named like the app's or a built-in's commands, views, kinds of search result or embeds (`settings`, `lists`, `note`, `dataSources`, in any case or dash spelling): one that is doesn't start, and the Extensions view says why. A trusted one may, which is how a customized built-in runs in its place. A customized copy you don't trust doesn't run: the built-in runs as it shipped, and its row in the Extensions view offers Trust. Every name extensions register things under (a command or view id, an embed's language, a status item, a kind of search result, a command bar prefix) has one owner (`web/src/ownership.ts`): an extension that runs in the page owns every name its manifest declares from the time extensions load, even while it's off on this device (but not once you turn it off), and a sandboxed one owns a name only if none in the page declares it. A built-in keeps its own names; between two other extensions, the first listed keeps a name. One that loses a name says so in the Extensions view, and the rest of it runs. What's registered under a name is used only while its extension owns the name, and keys, menus and status item clicks reach a command only while it's their extension's. Of what its manifest adds, it keeps each kind only by a rule for that kind (`confined` in `web/src/extension-host.ts`), so a new kind of contribution reaches sandboxed extensions only once it has one; URL embeds and layout parts, which draw in the page, are trusted extensions' only. Its views are **webviews**: frames it writes HTML into, in the app's colours, with `commonInk.post()` and `commonInk.onMessage()` to talk to its code.

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
- **contributes.keybindings.** A `key` like `"Mod-Shift-c"` (Mod is ⌘ on a Mac and Ctrl elsewhere, matched by the character typed) or a Vim normal-mode sequence like `"gC"`, which works while the Vim extension is on. A Vim key with `"operator": true` takes the place of Vim's operator of that key: Lists binds `>` and `<` so `>>`, `>j`, `>ip` and `>` on a selection move list items with their children. Settings can rebind keys. A sandboxed extension binds no Vim sequences, and no plain Ctrl+letter key (Vim's, and off a Mac Mod+letter too): its keys use Alt, or Mod or Ctrl with Shift or Alt.
- **contributes.configuration.** The extension's settings, as JSON Schema: `type`, `default`, `description`, `enum`, `minimum`, `maximum`, and `appliesAfterReload`. Their keys start with the extension's id. They get their own section in the settings editor, and `ctx.settings.get(key)` reads them.
- **permissions.** The most the extension may ask for, each with why. See ADR 0006 for the kinds and how asking works.
- **contributes.layout.** Parts of the windows' layout the extension draws, each with an `id`, a `title` and what it `requires`. The core knows two: `tabs` and `splits` (windows side by side). The Workbench declares tabs from medium width and splits from expanded. Where a part doesn't fit, it's put away and kept: see [Devices](#devices).
- **requires.** What the extension, or one of its commands, views, embeds or layout parts, needs from the device: `"requires": { "keyboard": true }`, `{ "width": "medium" }` (a width class: `compact`, `medium` from 600px, `expanded` from 840px, `large` from 1200px) or `{ "pointer": "fine" }` (a mouse or trackpad). Each one named must hold. See [Devices](#devices).

## Devices

Each browser you use Common Ink in is a device, with a file of its own: `.common-ink/users/<you>/devices/<id>/device.json`, written the first time the browser opens the app and kept in history. It says what was seen there (the width class, the pointer, touch, and a keyboard once one is found) and your choices for it: `keyboard` (`auto`, `yes` or `no`) and `extensions`, an override per extension (`on` or `off`). Settings › This device shows it.

A keyboard is assumed on a device with a mouse or trackpad that hovers (a desktop). Elsewhere it's found the first time a key arrives that a touch screen's keyboard doesn't send (any key outside a text field, or Escape, Tab, an arrow, or a ⌘ or Ctrl chord in one), and kept from then on.

Whether an extension is on, on a device:

1. `extensions.disabled` in settings turns it off everywhere.
2. This device's override: "On here" runs it whatever it needs; "Off here" turns it off on this device.
3. Its `requires`, checked against what the device has.
4. Otherwise it's on.

Vim needs a keyboard, so it's off on a phone until one is found, and then it starts in the open editors. Without a keyboard, no shortcut is hinted anywhere: `ctx.commands.shortcut()` answers nothing.

Each device keeps its own layout of windows and tabs, beside its device file (`devices/<id>/layout.json`). A new device that's expanded or wider starts from the layout of the wide device you used last; a narrower one starts from just the window and tab that were on show there (or, before any device had a layout, from the workspace's `.common-ink/layout.json`). Within a device, the width changing never closes anything: windows that can't be side by side are put away and the focused one fills the area, tabs are put away below medium, and both come back when there's room. The layout file is written only when you change the layout.

An extension whose requirements aren't met doesn't start, and the Extensions view says why: "Off on this device · needs a keyboard". When they become met, because a keyboard is found or you choose On here, it goes in as the app runs: a sandboxed extension starts at once, and a trusted one that changes editors reaches the open ones through their compartment. Turning one off here applies after a reload. A command, view or embed whose own requirements aren't met stays listed, greyed with why, and comes back when they are: a narrower window puts away what needs width, and doesn't stop anything.

## The context

`ctx` is an `ExtensionContext` (`web/src/extension-api.ts`):

- `ctx.commands.register(id, run)`, `run(id)` (a sandboxed extension can't run the app's app-only commands by its code or by a key, menu item or status item its manifest contributes: the app refuses and says an extension asked), `all()` (each with `off`, why it's off on this device, if it is), `shortcut(id)`, and `keybindings()`: every binding in effect, with the Vim sequences extensions declare (the Vim extension maps those). A sandboxed extension's commands, and its views, are named under its own id (`word-count.` or `wordCount.` for `word-count`), and it can't take one the app or another extension has. Its calls, keys, status bar items and menus reach a command or view only while the one registered under that id is the one it put in, checked as they're used, so one the app or another extension registers later is theirs. Its keys need Mod, Ctrl or Alt, and it can't take one the app, the note editor (undo and paste among them), Vim (its Ctrl keys), a built-in or a trusted extension binds, however it's spelled, on a Mac or off one; a key you bind in settings wins anyway. It binds no Vim sequences, since Vim has a meaning for nearly every one. Its `run` takes only its own commands, since an app command acts as you on whatever is open, and `views.show` and `open` only its own views. Its `ctx.workbench.open` and `split` open any note or file but the app's own under `.common-ink/`.
- **A sandboxed extension's calls have limits.** Each carries at most 2,000,000 characters' worth (as JSON), and together at most 10,000,000 characters' worth and 2,000 calls every 10 seconds. Past that a call is refused with the reason, so an extension reading many notes at once (more than about 1,700 in 10 seconds) has to wait and try again. A webview's message to its extension is held to the same size; one that's too big is dropped, with the reason in the webview's console.
- `ctx.device` is the device, for code that adapts to it rather than requiring something: `has("keyboard")` and `has("touch")`, `width` (its width class) and `atLeast("expanded")`, `pointer` (`"fine"` or `"coarse"`), `touch`, `why("keyboard")` (what the app went by, in words) and `onChange(fn)`, which runs when the width class, the pointer, touch or the keyboard changes. Sandboxed extensions get it too.
- `ctx.statusBar.set(id, text, tooltip?)` shows text in a status bar item the manifest declares (`contributes.statusBarItems`: `id`, `alignment` left or right, `priority`, and a `command` a click runs). Empty text hides it.
- `ctx.views.register(id, { resolve(webview) })` draws a view as a webview: set `webview.html`, and `webview.post()` and `webview.onMessage()` talk to its page. Trusted extensions may use `{ render(el) }` to draw into the page instead. Also `provide(prefix, make)` for views made from their id (like History's `version:<rev>:<path>`), `show`, `toggle`, `refresh`, `open`.
- `ctx.commandBar.provide({ prefix, placeholder, items(query) })` adds a command bar provider. The bar picks the provider with the longest prefix the query starts with. A sandboxed extension's prefix starts with its own name, as a word (`word-count ` or `wordCount:`).
- `ctx.files` lists, reads and writes files, each checked against `files:read` and `files:write`. Writes are changes in history by the extension, acting for you.
- `ctx.clipboard.read()` and `write(text)`, and `ctx.notifications.show(title, body)`, each checked against its permission.
- `ctx.media.session({ title, kind, el?, sticky?, play, pause, stop? })` says something plays, with the `media` permission: a `video` or `audio` it can play and pause, drawn in `el` if that's in a note's embed. It returns `{ id, set({ playing, title }), end() }`: call `set` as it starts and stops. The Media extension's mini player, the status bar and the media keys control the one played last (`ctx.media.current()`, `onChange`, `play(id)`, `pause(id)`, `stop(id)`, and `reveal(id)` to go to its note). A video playing in an embed floats in a small window while its note is out of sight, and docks when it's back; audio plays on unseen. The `media.whenHidden` setting picks `float`, `keepPlaying` or `pause`.
- `ctx.net.card(url)` gets a link's card (title, description, site, and its picture as a data: URL) the same way.
- `ctx.urlEmbeds.register(id, { render(el, { url, match }) })` draws a link alone on its line, for a URL embed the manifest declares (`contributes.urlEmbeds`: `id`, `title`, `pattern`, and the `frameHosts` it frames, which the page's policy allows only while the extension is on). The first pattern that matches draws it. Trusted extensions only.
- `ctx.data` reaches data sources' records (ADR 0007), such as calendar events: `status()` and `connect()`; `calendar.calendars()`, `events(from, to)` (each occurrence of a series, with its address), `event(address)`, `create(event)`, `update(address, change, scope)` and `remove(address, scope)`, where `scope` is `"this"`, `"following"` or `"all"` for an occurrence of a repeating event, and `onChange(fn)`; and `contacts.search(query)`. Reading asks for `data:calendar:read` or `data:contacts:read`, changing for `data:calendar:write`. A built-in's changes are yours; another extension's are by it, acting for you. A manifest names the data sources it shows in `contributes.dataSources` (`id`, `kind`, `title`).
- `ctx.net.fetch(url, init)` fetches through the Worker: only hosts the manifest declares and you've allowed, with no cookies or referrer, at most 1 MB. A sandboxed extension has no other way out.
- `ctx.layout` is the layout of windows and tabs: `get()`, `change(fn)` with `common-ink/layout`'s helpers, `close(group, index)`, `closeTabs(which)`, `isSaved(tab)` and `title(tab)`. `chrome({ window, tabs, divider, empty })` draws around the windows, as the Workbench extension does; one extension draws it, and it needs the `editor` permission. Things that open in a window carry `data-open` (the item as JSON) for chrome that drags them.
- `ctx.commands.menu(id)` lists the commands extensions add to a menu, such as `tabMenu`. A command in the `quickOpen` menu is listed in ⌘P with files, by its title without "Open" (Calendar's "Open calendar" is "Calendar").
- `ctx.workbench` opens files, says which file is focused and whether it has unsaved changes, splits a window (`split(direction, path?)`), reads and moves the focused window's tabs (`tabs()`, `moveTab(by)`), shows a notice (`notice(message, actions?, urgency?)`: a trusted extension passes `"alert"` for something refused or gone wrong, which news that comes after waits behind), and says whether there's a place to go back or forward to (`canGo(by)`).
- `ctx.embeds.register(language, provider)` draws an embed the manifest declares (`contributes.embeds`), with `activationEvents` `onEmbed:<language>`. When more than one extension declares a language, one that runs in the page draws it before a sandboxed one, and a sandboxed one can't register a language another draws. A contribution says:
  - its `language` (its name), `title` and `description`
  - its `syntax`: `"leaf"` for one line with nothing to close (`::timer{duration=25m}`), `"container"` for markdown wrapped in `:::name{…}` … `:::`, or `"fence"` for code in a fenced block. Without it, an embed with a `body` is a fence and one without is a leaf.
  - its `arguments`, each with its `type` (`string`, `number`, `duration` or `boolean`), `description` and `default`, and for its settings form an optional `label`, `enum` (a choice), `presets` (values in one click) or `hidden: true` (an `id`, kept as it is)
  - its `body`, what a container's or fence's content holds

  The core draws each embed's toolbar: Settings, a form made from its arguments that writes them back into the markdown as your edit, and Edit markdown. The provider gets the `Embed`: its `language`, `syntax`, `args`, `body`, `note` and a `key` that names it (its note and `id` argument, or which embed of its kind it is). `{ resolve(webview, embed) }` draws it as a webview, in a quiet frame with Stop, as tall as its page unless an argument `height` says otherwise; trusted extensions may use `{ render(el, embed) }` to draw into the page. Give it `update(webview, embed)` (or `update(el, embed)`) too, and new arguments or a new body (its settings were saved, or its markdown changed) come to what it already drew, so its frame isn't reloaded; without it, the embed is drawn again. It draws again each time it shows: keep anything that lasts in the extension, keyed by `embed.key`. See docs/embeds.md for writing them into notes.
- `ctx.state.get()` and `set(value)` keep the extension's state in `.common-ink/extensions/<id>/state.json`, as changes by it in history, synced and kept across reloads. No permission needed.
- `ctx.changes.describe(fn)` puts words to changes in history, such as "Completed 'Pay rent' (due Oct 1)".
- `ctx.events.onSaved` and `ctx.events.onFocus` say when a file saved and when focus moved.
- `ctx.settings.get(key)` reads any setting in effect.
- `ctx.extensions.api(id)` is the API another extension offers: whatever its `activate` returned (as in VS Code). Asking starts it if it hasn't started. It's `undefined` if that extension is off, failed, sandboxed or not there, so the caller does without. Tasks asks Daily notes where daily notes are this way, so there's one definition.
- `ctx.util.fuzzyFilter`, `notePathFor` and `label` are the helpers the built-ins use.
- `ctx.editor.extend(extension)` adds a CodeMirror extension to every note's editor, and with `{ everywhere: true }` to every editor, settings and code too (as Vim does). `ctx.editor.focused()` is the focused editor. `ctx.editor.markdown(extension)` adds a `@lezer/markdown` extension to the language notes are parsed with: new syntax (GFM, math) or how code blocks parse. The core's markdown is CommonMark. They need the `editor` permission, and only trusted extensions get it.

## Customizing a built-in

In the Extensions view, Customize copies a built-in's folder into the workspace as a workspace extension with the same id, and opens its code. Built-ins written in TypeScript are copied as the JavaScript the app runs (Source shows the TypeScript). The copy is trusted, since you made it yours, and after a reload it runs in place of the built-in. Revert to built-in deletes the copy (one change per file, which undo can take back).

## The default extensions, and the Catalog

The core is the file store and sync, history, the layout, commands and the command bar, settings, the Extensions view, permissions, safe mode, and a plain editor with markdown highlighting and standard keys. On by default, as extensions: Workbench (tab bars, splits, dragging, borders and the tab menu), Vim, Live preview, GFM, Code blocks, LaTeX, Lists (outliner editing, bullets, numbers and folding), Daily notes, Tasks, Timers (timer, stopwatch and alarm embeds), Media (background noise and the mini player), Link embeds (videos, posts, music and link cards), History, Calendar, Contacts, Uploads, and the command bar's Open by name and Command list. Each loads only when one of its activation events happens, so it isn't in the app's first download.

The Catalog, at the bottom of the Extensions view, lists first-party extensions that aren't on by default (Word count, Boards, Pomodoro, HTML app), from `/catalog/index.json` (`web/public/catalog/`). Install copies one's files into the workspace, where it runs sandboxed, at once: a sandboxed extension needs no reload to start, and a note's blocks for its embeds draw. A block for an embed only an uninstalled Catalog extension draws offers to install it. Other catalogs plug in with the `extensions.catalogs` setting: the address of each one's `index.json`, read through the Worker's safe fetch. Their extensions are other people's code, installed at your own risk. An index is `{"name": "…", "extensions": [{"id", "name", "version", "description", "path"}]}`, where `path` is the extension's folder, relative to the index.

## Turning extensions off, and safe mode

Turn an extension off in the Extensions view, or with `"extensions.disabled": ["history"]` in settings. It takes effect after a reload, and the status bar says so until then.

An extension whose manifest is wrong, or whose code throws while starting, is marked Failed in the Extensions view with its error, and the rest carry on. A command, view or listener that throws later is caught and shown the same way. If a workspace extension breaks the app anyway, open it with `?safe=1`: only built-ins start.
