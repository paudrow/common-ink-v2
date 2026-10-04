# Roadmap

Edited by hand. Agents implement items from here but don't add to it.

## Scope for v2

- Fundamental types: markdown notes, JSON config, data sources (calendar, contacts)
- Change log: diff history for every change, with authorship; rich undo/redo built on it
- CodeMirror 6 editor with a great vim mode
- VSCode-style windows, tabs and splits
- VSCode-style command bar and file search
- CLI and MCP server for agents
- Composable plugin model; built-in features ship as plugins
- Recurring todos (markdown) and recurring events (data source)
- Sign in with Google
- All user and workspace settings in JSON
- Hosted on Cloudflare, with offline mode; uploads in R2
- A very minimal, clean interface

## Order

1. **Editor on a real backend.** CodeMirror 6 with vim mode in one pane; open and save notes through a Worker and one Durable Object per workspace. Every save is a change with an author from day one. Dev user locally; deploys behind Cloudflare Access. CI and per-PR previews.
2. **Commands and the command bar.** A command registry, keybindings that call commands, the command bar and quick-open file search.
3. **Windows, tabs and splits.** Built on commands; layout state is workspace JSON. Milestone: daily-usable for notes.
4. **Visible history, CLI and MCP.** History view, diffs, attribution, undo/redo through history (including "undo what the agent did").
5. **Settings in JSON.** User and workspace settings with a schema, a read-only defaults view, keybindings in settings.
6. **Plugin API.** Extracted from what exists; command bar providers become the first plugins.
7. **Todos.** Inline due dates and recurrence, as a plugin.
8. **Google sign-in, then calendar and contacts** as data sources.
9. **Offline mode.** Cached notes, temporary local changes, unsent-changes indicator, merge on reconnect.
10. **Uploads to R2.**
