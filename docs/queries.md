# Queries

Every list of notes is a query: plain text you can read, edit and save. Search, the Feed and saved searches read it the same way, in the app, over MCP and in the CLI. The parser and matcher are `common-ink/query` (`worker/src/query.ts`), which extensions import too.

```text
launch "beta date" -draft in:Projects/ -is:archived sort:edited
```

## Words

| Write | Finds notes whose title or text has |
| --- | --- |
| `launch` | a word starting with "launch": launch, launched |
| `"beta date"` | "beta" followed by a word starting with "date" |
| `-draft` | no word starting with "draft" |

Case doesn't matter, and nor do accents where they're optional: on Latin, Greek, Hebrew and Arabic letters (`resume` finds "Résumé", `שלום` finds "שָׁלוֹם"). Marks that make another letter count (`мои` doesn't find "мой", nor `かっこう` "がっこう"). Words are runs of letters, digits and their marks, so `e-mail` is the phrase "e mail". Notes whose titles match come first.

## Filters

| Filter | Example | Means |
| --- | --- | --- |
| `is:` | `is:archived` `is:pinned` `is:trashed` | A state. Notes in Trash show only with `is:trashed`. Tasks add `is:open` and `is:done`. |
| `in:` | `in:Projects/` | In a folder, at any depth. Case doesn't matter. |
| `from:` | `from:me` `from:agent` `from:claude` `from:sync` `from:extension` | Who made the last change: you, any agent, an agent or extension by name, or a data source's sync. |
| `type:` | `type:note` `type:task` `type:event` | One kind of result. |
| `edited:` | `edited:today` `edited:yesterday` `edited:<7d` `edited:>3m` `edited:<=2026-10-01` | When it last changed: a day where you are, or an age in d, w, m (30 days) or y. |
| `has:` | `has:task` `has:embed` `has:event` | What a note holds: a task, an embed, or a link to an event. |
| `sort:` | `sort:edited` `sort:title` `sort:relevance` | The order. Without it, relevance when there are words, else newest first. |

Put `-` before a filter to negate it: `-is:archived`. Several `in:`, `from:` or `type:` filters take any of them (`in:Projects in:Journal`); other filters must all hold. Quote a value with spaces: `in:"Old projects/"`. Quote a word that looks like a filter to search for it as text: `"is:archived"`.

Extensions add filters for their own results, such as `due:` for tasks. A note never matches a filter it doesn't have. A filter with no value yet (`is:`) is left out, so results don't vanish while you type.

Archived notes are included, after the rest and marked, unless the query asks for `is:archived`.
