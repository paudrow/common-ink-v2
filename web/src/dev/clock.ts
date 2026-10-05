// The page's clock, moved by the `now` lever: Date reads the chosen time when it's set and runs on from
// there, across reloads of the tab, so todos, recurrence, timers and alarms see the day a test is
// written for. Only the page's own code sees it; sandboxed extensions' frames keep the real clock.

const RealDate = Date;
const KEPT = "common-ink-clock";

/** How far the page's clock is from the real one, in ms, and the lever that put it there. */
let clock = { lever: "real", offset: 0 };

export const clockNow = () => RealDate.now() + clock.offset;

/** Move the clock to `instant` (null for the real clock), named by the lever that asked for it. Setting the same lever again keeps it running. */
export function setClock(lever: string, instant: number | null, again = false): void {
  if (!again && lever === clock.lever) return;
  clock = { lever, offset: instant === null ? 0 : instant - RealDate.now() };
  try {
    sessionStorage.setItem(KEPT, JSON.stringify(clock));
  } catch {}
}

export function advanceClock(ms: number): void {
  setClock(clock.lever, clockNow() + ms, true);
}

/** Put the moved Date in place of the real one, picking up the clock this tab had before a reload. */
export function installClock(): void {
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) ?? "null") as typeof clock | null;
    if (kept && typeof kept.lever === "string" && Number.isFinite(kept.offset)) clock = kept;
  } catch {}
  function MovedDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(clockNow()).toString();
    return args.length ? new (RealDate as unknown as new (...a: unknown[]) => Date)(...args) : new RealDate(clockNow());
  }
  MovedDate.prototype = RealDate.prototype;
  MovedDate.now = clockNow;
  MovedDate.parse = RealDate.parse;
  MovedDate.UTC = RealDate.UTC;
  globalThis.Date = MovedDate as unknown as DateConstructor;
}
