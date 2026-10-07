// Swiping a row by touch (study, section 6.2): it follows the finger, its background says what letting go
// will do, and past 42% of its width letting go does it. A swipe starting within 24px of the screen's edge
// is the system's (back), not the row's. Holding a finger still on it for half a second is a long press.
// Trash's rows and the Feed's cards use it; `common-ink/swipe` offers it to extensions.

export interface SwipeAction {
  /** What letting go does, shown behind the row as it moves: "Archive". */
  label: string;
  /** Its colour, as `data-swipe` names it for the stylesheet: "archive" and "restore" green, "delete" red, "pin" the accent. */
  tone: string;
  run(): unknown;
}

const EDGE = 24;
const COMMIT = 0.42;
const HOLD_MS = 500;
const STILL_PX = 10;

/**
 * Make `row` swipeable, moving `body` inside it: `right` acts on a swipe to the right, `left` on one to
 * the left. `long`, if given, runs on a long press, with its pointer; the click that ends it is then swallowed
 * (if `long` draws the row again, the new one's click handler can tell that click by its pointerId). The row's
 * `data-swipe` says, while a swipe is under way, which way it goes ("right" or "left"), the tone of what
 * letting go would do, and "armed" once letting go does it.
 */
export function swipeable(row: HTMLElement, body: HTMLElement, actions: { right?: SwipeAction; left?: SwipeAction; long?: (pointerId: number) => void }): void {
  let start: { x: number; y: number; id: number } | null = null;
  let dx = 0;
  let sideways = false;
  let held = 0;
  let longDone = false;
  const reset = () => {
    clearTimeout(held);
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
    longDone = false;
    clearTimeout(held);
    const id = e.pointerId;
    if (actions.long)
      held = window.setTimeout(() => {
        longDone = true;
        actions.long!(id);
      }, HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const x = e.clientX - start.x;
    if (Math.hypot(x, e.clientY - start.y) > STILL_PX) clearTimeout(held);
    if (longDone) return;
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
    row.dataset.swipe = action ? `${dx > 0 ? "right" : "left"} ${action.tone}${Math.abs(dx) > row.offsetWidth * COMMIT ? " armed" : ""}` : "";
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
  // A long press's lifting finger is no tap; a click from the keyboard (detail 0) always is.
  row.addEventListener(
    "click",
    (e) => {
      if (!longDone || e.detail === 0) return;
      longDone = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true },
  );
  row.addEventListener("contextmenu", (e) => actions.long && e.pointerType !== "mouse" && e.preventDefault());
  // Once it's a swipe, the finger's moves are the row's alone: the browser doesn't also make a gesture
  // of them, which could take the next tap (on the dialog a swipe left opens) as its own.
  row.addEventListener("touchmove", (e) => sideways && e.cancelable && e.preventDefault(), { passive: false });
}
