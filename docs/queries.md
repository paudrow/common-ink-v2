# Queries

Every list of notes is a query: plain text you can read, edit and save. Search, the Feed and saved searches read it the same way, in the app, over MCP (`search`) and in the CLI (`common-ink search`). The parser and matcher are `common-ink/query` (`worker/src/query.ts`), which extensions import too.

In the app, ⌘K or ⌘P (Ctrl off a Mac) opens search: notes first, then tasks, events and commands, each in a section. Tab completes a filter (`is:a` becomes `is:archived`) and, on a value, moves on to the next one. On a phone it fills the screen, and chips under the field (Agents, Mine, This week, Events, Tasks) write their filter into the query, or take it out.

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
| `is:` | `is:archived` `is:pinned` `is:trashed` | A state. Archived notes are listed in `.common-ink/archive.json`, pinned ones in `.common-ink/pins.json` (in the order pinned). Notes in Trash show only with `is:trashed`. Tasks add `is:open` and `is:done`. |
| `in:` | `in:Projects/` | In a folder, at any depth. Case doesn't matter. |
| `from:` | `from:me` `from:agent` `from:claude` `from:sync` `from:extension` | Who made the last change: you, any agent, an agent or extension by name, or a data source's sync. |
| `type:` | `type:note` `type:task` `type:event` | One kind of result. |
| `edited:` | `edited:today` `edited:yesterday` `edited:<7d` `edited:>3m` `edited:<=2026-10-01` | When it last changed: a day where you are, or an age in d, w, m (30 days) or y. |
| `has:` | `has:task` `has:embed` `has:event` | What a note holds: a task, an embed, or a link to an event. |
| `sort:` | `sort:edited` `sort:title` `sort:relevance` | The order. Without it, relevance when there are words, else newest first. A sort can't be negated. |

Put `-` before a filter to negate it: `-is:archived`. Several `in:`, `from:` or `type:` filters take any of them (`in:Projects in:Journal`); other filters must all hold. Quote a value with spaces: `in:"Old projects/"`. Quote a word that looks like a filter to search for it as text: `"is:archived"`.

Extensions add filters for their own results, such as `due:` for tasks. A note never matches a filter it doesn't have. A filter with no value yet (`is:`) is left out, so results don't vanish while you type.

Archived notes are included, after the rest and marked, unless the query asks for `is:archived`.

A search orders every note that might match by what's known without reading it (its path, title, last change and archive), then reads notes in that order to test words and `has:`, at most 1000 of them. So its first results are the right ones however many notes there are. When there were more to read, it says so (`more`; "More results…" in the app, `1000+ found` in the CLI), and its count is of the notes it read.
