# Boards tour

Boards draws a Kanban board made of markdown. It runs sandboxed, so the first time it reads or changes a note it asks.

:::kanban
## To do
- Write the outline
- Book the venue
- Send the invitations

## Doing
- Draft the slides
  with speaker notes

## Done
- Pick a date
:::

Drag a card to another column (or use its ← → buttons): it moves at once, and the markdown above changes to match, as a change by Boards in history. Put the cursor in it to see it: the board is real markdown between `:::kanban` and `:::`.

Task lists gathered from your notes are the Todos extension's: see [[Todos tour]].
