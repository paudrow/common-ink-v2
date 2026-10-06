// Swiping a row by touch: it follows the finger, its background says what letting go will do, and past
// 42% of its width letting go does it (study, section 6.2). A swipe starting within 24px of the screen's
// edge is the system's (back), not the row's.

export interface SwipeAction {
  label: string;
  /** "restore" draws green, "delete" red. */
  tone: "restore" | "delete";
  run(): unknown;
}

const EDGE = 24;
const COMMIT = 0.42;

/** Make `row` swipeable, moving `body` inside it: `right` acts on a swipe to the right, `left` on one to the left. */
export function swipeable(row: HTMLElement, body: HTMLElement, actions: { right?: SwipeAction; left?: SwipeAction }): void {
  let start: { x: number; y: number; id: number } | null = null;
  let dx = 0;
  let sideways = false;
  const reset = () => {
    body.style.translate = "";
    row.dataset.swipe = "";
    row.style.removeProperty("--swipe-label");
    start = null;
    dx = 0;
    sideways = false;
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  row.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const x = e.clientX - start.x;
    if (!sideways) {
      // A swipe moves sideways more than it scrolls; anything else is a scroll, and the row lets go.
      if (Math.abs(x) < 8) return;
      if (Math.abs(e.clientY - start.y) > Math.abs(x)) return reset();
      sideways = true;
      row.setPointerCapture(e.pointerId);
    }
    const action = x > 0 ? actions.right : actions.left;
    dx = action ? x : 0;
    body.style.translate = `${dx}px 0`;
    row.dataset.swipe = action ? `${action.tone}${Math.abs(dx) > row.offsetWidth * COMMIT ? " armed" : ""}` : "";
    if (action) row.style.setProperty("--swipe-label", JSON.stringify(action.label));
  });
  const end = () => {
    const action = dx > 0 ? actions.right : actions.left;
    const done = action && Math.abs(dx) > row.offsetWidth * COMMIT;
    reset();
    if (done) void action.run();
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", reset);
}
