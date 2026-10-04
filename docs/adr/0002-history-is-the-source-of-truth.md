# History is the source of truth

Every edit, whether from the UI, the CLI, MCP, a plugin or sync, is recorded as a change with an author, a diff and a base revision. A file's current state is derived from these changes. Diff history, attribution, filtered undo ("undo what the agent just did"), offline sync and observability all come from this one mechanism, instead of being added on separately.

## Consequences

The editor's own undo stack only covers in-progress typing, and is committed to history on pause or blur. Writes based on an old revision are merged, never silently overwritten.
