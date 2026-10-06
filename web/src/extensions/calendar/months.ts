// Month and year views: a strip of months (or years) side by side that scrolls sideways through dates
// for as long as you like, snapping to each. Only a few are drawn; near either end the strip is drawn
// again around where you are, with the scroll moved to match. A month shows each day's events (a click
// on an empty place makes an all-day event, an event drags to another day); a year shows each day's
// busyness, and a click on a day shows that week.
import type { Occurrence } from "common-ink/calendar";
import { el, reducedMotion } from "./dom.ts";
import { addDays, addMonths, daysBetween, monthWeeks, startOfMonth, startOfYear, weekdays, type Day } from "./model.ts";
import { localSpan, timeLabel, type CalendarView, type ViewEnv } from "./views.ts";

const AROUND = 3;
const SLOP = 4;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A strip of panels, one per period, scrolling sideways and snapping to each. */
abstract class Strip implements CalendarView {
  readonly root: HTMLElement;
  /** Its listeners, let go of when it goes. */
  private listening = new AbortController();
  protected scroller: HTMLElement;
  protected track: HTMLElement;
  protected first: Day;
  protected anchor: Day;
  protected width = 0;
  private resize: ResizeObserver;
  private settle = 0;
  protected onScreen: Occurrence[] = [];

  constructor(
    protected env: ViewEnv,
    className: string,
    anchor: Day,
  ) {
    this.anchor = this.periodOf(anchor);
    this.first = this.shift(this.anchor, -AROUND);
    this.track = el("div", { class: "cal-track" });
    this.scroller = el("div", { class: "cal-strip", tabindex: "-1" }, this.track);
    this.root = el("div", { class: `cal-panels ${className}` }, this.scroller);
    this.scroller.addEventListener("scroll", () => this.scrolled(), { passive: true, signal: this.listening.signal });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.root);
    requestAnimationFrame(() => this.layout());
  }

  /** The start of the period a day is in, and one some periods on. */
  protected abstract periodOf(day: Day): Day;
  protected abstract shift(start: Day, n: number): Day;
  /** One period's panel. */
  protected abstract panel(start: Day, events: Occurrence[]): HTMLElement;

  private index(start: Day) {
    for (let i = 0; i <= 2 * AROUND; i++) if (this.shift(this.first, i) === start) return i;
    return -1;
  }

  private layout() {
    this.width = this.scroller.clientWidth;
    if (!this.width) return;
    this.draw();
    this.scroller.scrollLeft = Math.max(0, this.index(this.anchor)) * this.width;
  }

  goto(day: Day, smooth: boolean) {
    const start = this.periodOf(day);
    const at = this.index(start);
    if (at < 1 || at > 2 * AROUND - 1) {
      this.first = this.shift(start, -AROUND);
      this.anchor = start;
      this.draw();
      this.scroller.scrollLeft = AROUND * this.width;
      this.env.scrolled(start);
      return;
    }
    this.scroller.scrollTo({ left: at * this.width, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  private scrolled() {
    const at = Math.round(this.scroller.scrollLeft / (this.width || 1));
    const anchor = this.shift(this.first, at);
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.env.scrolled(anchor);
    }
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => {
      const now = Math.round(this.scroller.scrollLeft / (this.width || 1));
      if (now >= 1 && now <= 2 * AROUND - 1) return;
      this.first = this.shift(this.anchor, -AROUND);
      this.draw();
      this.scroller.scrollLeft = AROUND * this.width;
    }, 140);
  }

  redraw() {
    this.draw();
  }

  /** Each period's place in the strip, kept from one drawing to the next: they're where scrolling stops. */
  private slots = new Map<Day, HTMLElement>();

  protected draw() {
    const last = this.shift(this.first, 2 * AROUND + 1);
    const events = this.env.events(this.weekBefore(this.first), this.weekAfter(last)) ?? [];
    this.onScreen = [];
    const left = this.scroller.scrollLeft;
    const starts = Array.from({ length: 2 * AROUND + 1 }, (_, i) => this.shift(this.first, i));
    const slots = starts.map((start) => {
      const slot = this.slots.get(start) ?? el("div", { class: "cal-slot" });
      slot.style.width = `${this.width}px`;
      slot.replaceChildren(this.panel(start, events));
      return slot;
    });
    for (const [start, slot] of this.slots) if (!slots.includes(slot)) (slot.remove(), this.slots.delete(start));
    starts.forEach((start, i) => this.slots.set(start, slots[i]));
    // In order, moving only what's out of place.
    slots.forEach((slot, i) => {
      if (this.track.children[i] !== slot) this.track.insertBefore(slot, this.track.children[i] ?? null);
    });
    this.track.style.width = `${(2 * AROUND + 1) * this.width}px`;
    if (this.scroller.scrollLeft !== left) this.scroller.scrollLeft = left;
  }

  /** A month's grid shows days of the weeks around it too. */
  protected weekBefore(day: Day) {
    return addDays(day, -7);
  }

  protected weekAfter(day: Day) {
    return addDays(day, 7);
  }

  visible(): Occurrence[] {
    const end = this.shift(this.anchor, 1);
    return this.onScreen.filter((o) => {
      const s = localSpan(o);
      return s.startDay < end && s.endDay >= this.anchor;
    });
  }

  reveal(address: string) {
    this.root.querySelector<HTMLElement>(`[data-address="${CSS.escape(address)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  destroy() {
    this.listening.abort();
    this.resize.disconnect();
    clearTimeout(this.settle);
    this.root.remove();
  }
}

/** Events on each day, in order: all-day ones first, then by start. */
function byDay(events: Occurrence[]): Map<Day, Occurrence[]> {
  const days = new Map<Day, Occurrence[]>();
  for (const o of [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))) {
    const s = localSpan(o);
    const last = o.allDay ? addDays(s.endDay, -1) : s.end === 0 && s.endDay > s.startDay ? addDays(s.endDay, -1) : s.endDay;
    for (let d = s.startDay; d <= last; d = addDays(d, 1)) days.set(d, [...(days.get(d) ?? []), o]);
  }
  return days;
}

export class MonthView extends Strip {
  private press: { x: number; y: number; pointer: number; o?: Occurrence; node?: HTMLElement; day?: Day } | null = null;
  private dragging = false;

  constructor(env: ViewEnv, anchor: Day) {
    super(env, "cal-months", anchor);
    this.root.addEventListener("pointerdown", (e) => this.down(e));
    this.root.addEventListener("pointermove", (e) => this.moveTo(e));
    this.root.addEventListener("pointerup", (e) => this.up(e));
  }

  protected periodOf(day: Day) {
    return startOfMonth(day);
  }

  protected shift(start: Day, n: number) {
    return addMonths(start, n);
  }

  protected panel(month: Day, events: Occurrence[]): HTMLElement {
    const today = this.env.today();
    const focused = this.env.focused();
    const days = byDay(events);
    const weeks = monthWeeks(month, this.env.weekStart);
    const rows = weeks.map((week) =>
      el(
        "div",
        { class: "cal-week" },
        ...week.map((day) => {
          const list = days.get(day) ?? [];
          const inMonth = day.slice(0, 7) === month.slice(0, 7);
          if (inMonth) this.onScreen.push(...list.filter((o) => !this.onScreen.includes(o)));
          const shown = list.slice(0, 3);
          return el(
            "div",
            { class: `cal-cell${inMonth ? "" : " is-other"}${day === today ? " is-today" : ""}`, "data-day": day },
            el("button", { type: "button", class: "cal-daynum", title: "Show this week", onclick: () => this.env.show("week", day) }, String(+day.slice(8, 10))),
            ...shown.map((o) =>
              el(
                "div",
                { class: `cal-chip${o.allDay ? " is-all-day" : ""}${o.address === focused ? " is-focused" : ""}`, style: { "--event": this.env.color(o) }, "data-address": o.address, role: "button", tabindex: "-1", title: o.title },
                o.allDay ? "" : el("span", { class: "cal-chip-time" }, timeLabel(o.start)),
                o.title || "(No title)",
              ),
            ),
            list.length > shown.length ? el("button", { type: "button", class: "cal-more", onclick: () => this.env.show("agenda", day) }, `${list.length - shown.length} more`) : null,
          );
        }),
      ),
    );
    return el(
      "section",
      { class: "cal-panel cal-month", "data-month": month, style: { "--weeks": String(weeks.length) } },
      el("div", { class: "cal-weekdays" }, ...weekdays(this.env.weekStart).map((d) => el("div", {}, DAY_NAMES[d]))),
      el("div", { class: "cal-weeks" }, ...rows),
    );
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const chip = target.closest<HTMLElement>(".cal-chip");
    const cell = target.closest<HTMLElement>(".cal-cell");
    if (!cell) return;
    this.press = { x: e.clientX, y: e.clientY, pointer: e.pointerId, ...(chip ? { o: this.onScreenOrAll(chip.dataset.address!), node: chip } : {}), day: cell.dataset.day };
  }

  private onScreenOrAll(address: string): Occurrence | undefined {
    return this.onScreen.find((o) => o.address === address) ?? (this.env.events(this.weekBefore(this.first), this.weekAfter(this.shift(this.first, 2 * AROUND + 1))) ?? []).find((o) => o.address === address);
  }

  private moveTo(e: PointerEvent) {
    const p = this.press;
    if (!p?.o || !p.node || e.pointerId !== p.pointer || !this.env.writable(p.o)) return;
    if (!this.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < SLOP) return;
    if (!this.dragging) {
      this.dragging = true;
      this.root.setPointerCapture(e.pointerId);
      p.node.classList.add("is-moving");
    }
    p.node.style.transform = `translate(${e.clientX - p.x}px, ${e.clientY - p.y}px)`;
  }

  private up(e: PointerEvent) {
    const p = this.press;
    this.press = null;
    const dragging = this.dragging;
    this.dragging = false;
    if (!p || e.pointerId !== p.pointer) return;
    if (!dragging) {
      if (p.o && p.node) return this.env.open(p.o, p.node.getBoundingClientRect());
      if (p.day) return this.env.create({ allDay: true, startDay: p.day, endDay: addDays(p.day, 1) }, new DOMRect(e.clientX, e.clientY, 1, 1));
      return;
    }
    const to = (document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList.contains("cal-cell")) as HTMLElement | undefined)?.dataset.day;
    if (!p.o || !to || !p.day || to === p.day) return this.redraw();
    const shift = daysBetween(p.day, to);
    const s = localSpan(p.o);
    this.env.move(p.o, p.o.allDay ? { allDay: true, startDay: addDays(s.startDay, shift), endDay: addDays(s.endDay, shift) } : { allDay: false, startDay: addDays(s.startDay, shift), start: s.start, endDay: addDays(s.endDay, shift), end: s.end }, p.node!.getBoundingClientRect());
  }
}

export class YearView extends Strip {
  constructor(env: ViewEnv, anchor: Day) {
    super(env, "cal-years", anchor);
  }

  protected periodOf(day: Day) {
    return startOfYear(day);
  }

  protected shift(start: Day, n: number) {
    return `${+start.slice(0, 4) + n}-01-01`;
  }

  protected weekBefore(day: Day) {
    return day;
  }

  protected weekAfter(day: Day) {
    return day;
  }

  protected panel(year: Day, events: Occurrence[]): HTMLElement {
    const today = this.env.today();
    const days = byDay(events);
    const months = Array.from({ length: 12 }, (_, m) => addMonths(year, m));
    return el(
      "section",
      { class: "cal-panel cal-year", "data-year": year.slice(0, 4) },
      ...months.map((month) =>
        el(
          "div",
          { class: "cal-mini" },
          el("button", { type: "button", class: "cal-mini-title", onclick: () => this.env.show("month", month) }, new Date(`${month}T12:00:00Z`).toLocaleDateString([], { month: "long", timeZone: "UTC" })),
          el("div", { class: "cal-mini-days" }, ...weekdays(this.env.weekStart).map((d) => el("span", { class: "cal-mini-dow" }, DAY_NAMES[d][0])), ...monthWeeks(month, this.env.weekStart).flat().map((day) => {
            const count = days.get(day)?.length ?? 0;
            const inMonth = day.slice(0, 7) === month.slice(0, 7);
            if (!inMonth) return el("span", { class: "cal-mini-day is-other" });
            return el(
              "button",
              { type: "button", class: `cal-mini-day${day === today ? " is-today" : ""}${count ? " has-events" : ""}`, style: { "--busy": String(Math.min(1, count / 4)) }, title: `${count} event${count === 1 ? "" : "s"}`, onclick: () => this.env.show("week", day) },
              String(+day.slice(8, 10)),
            );
          })),
        ),
      ),
    );
  }

  visible(): Occurrence[] {
    return [];
  }
}
