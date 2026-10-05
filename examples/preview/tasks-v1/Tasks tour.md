# Tasks tour

A task is a checkbox line. Tokens anywhere in it say more, todo.txt style: `due:2026-10-01` (or `due:2026-10-01T09:30`), `start:` (hidden until then), `rec:` (how it repeats), `until:` and `times:` (when the repeat ends), `!high` or `!low`, `@person`, and `#tag`. The line is the source of truth: every change rewrites one token in place.

- [ ] Send the Q4 invoice to Acme due:{{today+1}} rec:monthly @jane !high #work/clients
- [ ] Plan the offsite with @sam due:{{today+6}} #work
- [ ] Read the onboarding doc start:{{today+1}} due:{{today+4}}

## Everything open

::tasks{group=due}

## Home, by priority

::tasks{tag=home group=priority}

## Due by today

::tasks{due="<=today"}

Tick one in a list and it's ticked in its note. Click its words to change them, a chip to change that token, ⚙ for every field, ↗ to open its note at the line.
