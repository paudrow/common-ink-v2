# Writing an extension

Built-in features are extensions on the same manifest and API anyone else's use (ADR 0006): see `web/src/extensions/`. An extension is a folder with two kinds of file:

- `extension.json`, the manifest: what the extension is, what it adds, when its code starts, and what it may ask for.
- Its code: `main` (default `index.js`), an ES module whose default export has `activate(ctx)`, plus any modules `main` imports from the same folder. It imports nothing else; everything it needs comes through `ctx`.

A workspace extension's folder is `.common-ink/extensions/<id>/`, edited like a note and kept in history. The folder's name is the id.

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
- **contributes.keybindings.** A `key` like `"Mod-Shift-c"` (Mod is ⌘ on a Mac and Ctrl elsewhere, matched by the character typed) or a Vim normal-mode sequence like `"gC"`. Settings can rebind them.
- **contributes.configuration.** The extension's settings, as JSON Schema: `type`, `default`, `description`, `enum`, `minimum`, `maximum`, and `appliesAfterReload`. Their keys start with the extension's id. They get their own section in the settings editor, and `ctx.settings.get(key)` reads them.
- **permissions.** The most the extension may ask for, each with why. See ADR 0006 for the kinds and how asking works.

## The context

`ctx` is an `ExtensionContext` (`web/src/extension-api.ts`):

- `ctx.commands.register(id, run)`, `run(id)`, `all()`, `shortcut(id)`.
- `ctx.views.register(id, renderer)`, `provide(prefix, make)` for views made from their id (like History's `version:<rev>:<path>`), `show`, `toggle`, `refresh`, `open`.
- `ctx.commandBar.provide({ prefix, placeholder, items(query) })` adds a command bar provider. The bar picks the provider with the longest prefix the query starts with.
- `ctx.files` lists, reads, writes and uploads files. Writes are changes by the signed-in person.
- `ctx.workbench` opens files, says which file is focused, and shows a notice.
- `ctx.changes.describe(fn)` puts words to changes in history, such as "Completed 'Pay rent' (due Oct 1)".
- `ctx.events.onSaved` and `ctx.events.onFocus` say when a file saved and when focus moved.
- `ctx.settings.get(key)` reads any setting in effect.
- `ctx.util.fuzzyFilter`, `notePathFor` and `label` are the helpers the built-ins use.
- `ctx.editor.extend(extension)` and `ctx.editor.focused()` change note editors. They need the `editor` permission, and only trusted extensions get it.

## Customizing a built-in

In the Extensions view, Customize copies a built-in's folder into the workspace as a workspace extension with the same id, and opens its code. After a reload the copy runs in place of the built-in. Revert to built-in deletes the copy (one change per file, which undo can take back). Only built-ins written in plain JavaScript can be copied this way for now.

## Turning extensions off, and safe mode

Turn an extension off in the Extensions view, or with `"extensions.disabled": ["history"]` in settings. It takes effect after a reload, and the status bar says so until then.

An extension whose manifest is wrong, or whose code throws while starting, is marked Failed in the Extensions view with its error, and the rest carry on. A command, view or listener that throws later is caught and shown the same way. If a workspace extension breaks the app anyway, open it with `?safe=1`: only built-ins start.
