# Writing a plugin

Built-in features are plugins on the same API offered to everyone else (ADR 0004). The command bar's two providers and the history panel are built this way: see `web/src/plugins/`.

## A workspace plugin

A workspace plugin is two files in the workspace, edited like any note and kept in history (ADR 0005):

- `.common-ink/plugins/<id>/plugin.json`: `{"id": "<id>", "name": "…", "description": "…"}`. The folder's name is the id; an `"id"` in the file must match it.
- `.common-ink/plugins/<id>/index.js`: an ES module whose default export has `activate(ctx)`. It imports nothing: everything it needs comes through `ctx`.

```js
export default {
  activate(ctx) {
    ctx.commands.register({
      id: "wordCount.show",
      title: "Count words",
      run: () => {
        const text = ctx.workbench.focusedView()?.state.doc.toString() ?? "";
        console.log(`${text.split(/\s+/).filter(Boolean).length} words`);
      },
    });
  },
};
```

Plugins start when the app loads, so a change to a plugin's files applies after a reload. The status bar says when one is needed ("Plugin changes apply after reload · Reload"), and so does the Plugins view (⌘⇧P, Show plugins).

The Worker serves `index.js` at `/plugins/<id>/index.js` from the workspace, so the page loads it from its own origin under `script-src 'self'`.

## The plugin context

`ctx` is a `PluginContext` (`web/src/plugins.ts`):

- `ctx.commands.register({ id, title, run })` adds a command. It shows in ⌘⇧P, keybindings in settings can call it by id, and other plugins can `ctx.commands.run(id)` it. `ctx.commands.shortcut(id)` is its shortcut as shown.
- `ctx.keybindings.add({ key, command })` gives a plugin's command a default shortcut. Settings can rebind or unbind it.
- `ctx.editor.extend(extension)` adds a CodeMirror extension to every note's editor, such as decorations.
- `ctx.commandBar.provide({ prefix, placeholder, items(query) })` adds a command bar provider. The bar picks the provider with the longest prefix the query starts with.
- `ctx.panels.register({ id, title, render(el) })` adds a side panel, which also opens in a window. `toggle`, `show` and `refresh` control it.
- `ctx.workbench.provideViews(prefix, make)` adds views made from their id, such as `version:<rev>:<path>`, and `ctx.workbench.openView(id)` opens one in a window.
- `ctx.sources` reads data sources (calendar events, contacts) for the signed-in person. The Plugins view lists the ones a plugin reads.
- `ctx.files` lists, reads and writes files. Writes are changes by the signed-in person.
- `ctx.workbench` opens files and tells you what's focused, including the focused CodeMirror view.
- `ctx.events.onSaved` and `ctx.events.onFocus` say when a file saved and when focus moved.
- `ctx.util.fuzzyFilter` and `ctx.util.notePathFor` are the helpers the built-ins use.
- `ctx.settings()` is the current settings.

## Customizing a built-in

In the Plugins view, Customize copies a built-in into the workspace as a workspace plugin with the same id, and opens its `index.js`. After a reload the copy runs in place of the built-in. Revert to built-in deletes the copy (two changes, which undo can take back).

Only self-contained built-ins can be customized: plain JavaScript on `ctx` alone, like the command bar's providers. History uses the app's own modules, so its source shows read-only and Customize is off.

## Turning plugins off, and safe mode

Turn a plugin off in the Plugins view, or with `"plugins.disabled": ["history"]` in settings. It takes effect after a reload.

A plugin that throws while loading or starting is marked Failed in the Plugins view with its error, and the rest start as usual. A command, view or listener that throws later is caught and shown the same way. If a workspace plugin breaks the app anyway, open it with `?safe=1`: only built-ins start, and the Plugins view lists the workspace plugins it skipped. The error notice links there.
