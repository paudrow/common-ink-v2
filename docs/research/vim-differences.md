# Where Vim mode differs from Vim

Common Ink's Vim mode is codemirror-vim (`@replit/codemirror-vim`) with the app's own commands mapped onto it. These are the differences from Vim we know of that come from codemirror-vim itself. Fixing them means a change upstream, or a patch to it.

## A visual block's `I` writes on lines too short for the block

In Vim, `I` in a visual block inserts only on lines that reach the block (`:help v_b_I`): "lines that are short will remain unaffected". So `<C-v>` over three lines, the middle one empty, then `I#<Esc>`, comments the first and last lines and leaves the empty one alone.

codemirror-vim puts a cursor on every line of the block, empty ones too, so the empty line gets `#` as well.

- Found by: the verifier of #123 ("block G over table at note end").
- Upstream: codemirror-vim's block insert would skip a line whose length is less than the block's start column, as Vim does. In the meantime, a block's `I` over blank lines should be checked by eye.

## The cursor after `u`

Vim puts the cursor at the start of what the undone change changed. codemirror-vim does too, but counts the start as the first character the change touched.

For a shift, that's the start of the line, where the indent was added. So after `>>` then `.` then `u`, the cursor is in column 1, where Vim puts it on the line's first non-blank (column 3 for a two-space indent).

- Found by: the verifier of #133.
- Upstream: `runHistoryCommand` sets the cursor to `$changeStart`. For a change made of only whitespace before a line's text, Vim's position is that line's first non-blank.

## Not differences any more

- A change typed slowly (`cw…`, `o…`, `A…`, a block's `I…`) was several undo steps. Since the change that adds this note, it's one, as in Vim (`web/src/extensions/vim/undo.ts`).
