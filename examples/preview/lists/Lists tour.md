# Lists tour

Lists edit like an outliner. Put the cursor on an item and try the keys below. The line you're on doesn't move: its indent, bullet and number stay where they are, and a bullet shows its `-` only while the cursor is on it.

- Plan the garden
  - Order seeds
    - Tomatoes, the ones that did well last summer by the south fence, and a second variety to try
    - Basil
  - Build the raised bed
- Fix the bike
  - Patch the inner tube
- Call the plumber

1. Preheat the oven
2. Mix the dry things
   1. Flour
   2. Sugar
3. Fold in the butter
4. Bake for twenty minutes

- [ ] Book flights
- [ ] Pack
  - [ ] Passport
  - [ ] Charger

## Keys

- Tab and Shift-Tab, Alt-Right and Alt-Left, or >> and << in Vim (> and < on a visual selection): indent or dedent an item with its children. An item indents only under the item above it, one level at a time; the first item of a list can't.
- Alt-Up and Alt-Down, or [e and ]e in Vim: move an item, with its children, past the one above or below.
- Enter carries the list on; Enter on an empty item steps out a level, then out of the list.
- za in Vim, or a click on a bullet that has children: fold them away, and back.
- ⌘⇧P, Make bullets, Make a numbered list, Make todos: convert the items you're on.
