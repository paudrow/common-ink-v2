# Boards tour

Boards draws two embeds: a task list gathered live from your notes, and a Kanban board made of markdown. It runs sandboxed, so the first time it reads your notes it asks.

## Every open todo

```tasks
```

## Due this week

```tasks due=week
```

Check one off here, and it's checked off in its note; a note's name opens it. Add a todo to any note (`- [ ] something due:2026-10-09`) and the lists above update.

## A board

```kanban
## To do
- Write the outline
- Book the venue
- Send the invitations

## Doing
- Draft the slides
  with speaker notes

## Done
- Pick a date
```

Drag a card to another column (or use its ← → buttons): the markdown above changes to match, as a change by Boards in history. Put the cursor in the block to see it.
