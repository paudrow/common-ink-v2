# Todo edge cases

Tasks whose chips sit close to their words, for checking that nothing overlaps at any width.

- [ ] A task with a long title that wraps onto a second line when the window is narrow, then a due date due:{{today}}
- [ ] Every chip at once due:{{today+1}} rec:weekly @sam !high #home/errands
- [x] Done and dated due:{{today-2}} done:{{today-2}}
- Groceries
  - [ ] Milk due:{{today}}
  - [ ] Bread, the sourdough from the market on Saturday morning due:{{today+6}} rec:2w
  - [ ] The last one, a month out due:{{today+30}} rec:monthly times:3
