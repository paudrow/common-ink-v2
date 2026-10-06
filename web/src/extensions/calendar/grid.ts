// The time grid, for 3 days and a week: day columns side by side under a row of all-day events, hours
// down the side. It scrolls sideways through dates for as long as you like: only a stretch of days is
// drawn, and when you near its end it's drawn again around where you are, with the scroll moved to
// match, so nothing on screen moves. Scrolling snaps to a day (3 days) or a week. In a column, a click
// makes a 30-minute event and a drag makes one as long as the drag; an event drags to move, and its
// bottom edge drags to change when it ends.
import type { Occurrence } from "common-ink/calendar";
import { el, reducedMotion } from "./dom.ts";
import { addDays, clock, daysBetween, dragRange, period, placeDay, snap, weekday, type Day, type View } from "./model.ts";
import { localSpan, longEvent, timeLabel, type CalendarView, type ViewEnv } from "./views.ts";

/** One hour's height, in pixels. */
export const HOUR = 48;
const GUTTER = 56;
const LANE = 22;
/** Periods drawn either side of the one on screen. */
const AROUND = 3;
/** How far a press moves before it's a drag. */
const SLOP = 4;

type Drag =
  | { kind: "create"; day: number; from: number; to: number; ghost: HTMLElement }
  | { kind: "move" | "resize"; o: Occurrence; node: HTMLElement; grab: number; day: number; start: number; end: number; startDay: number }
  | { kind: "moveAllDay"; o: Occurrence; node: HTMLElement; grabDay: number; shift: number };

export class TimeGrid implements CalendarView {
  readonly root: HTMLElement;
  /** Its listeners, let go of when it goes. */
  private listening = new AbortController();
  private scroller: HTMLElement;
  private canvas: HTMLElement;
  private headDays: HTMLElement;
  private allDay: HTMLElement;
  private hours: HTMLElement;
  private body: HTMLElement;
  private days: number;
  /** The first day drawn. */
  private first: Day;
  /** The first day on screen. */
  private anchor: Day;
  private col = 100;
  private resize: ResizeObserver;
  private tick: number;
  private settle = 0;
  /** Whether the columns have their width yet. */
  private laidOut = false;
  private press: { x: number; y: number; pointer: number; target: "event" | "allday" | "empty"; o?: Occurrence; node?: HTMLElement; day: number; minutes: number; edge: boolean } | null = null;
  private drag: Drag | null = null;
  private onScreen: Occurrence[] = [];
  private columns = new Map<Day, HTMLElement>();

  constructor(
    private env: ViewEnv,
    private view: Extract<View, "3day" | "week">,
    anchor: Day,
  ) {
    this.days = view === "3day" ? 3 : 7;
    this.anchor = this.periodStart(anchor);
    this.first = addDays(this.anchor, -this.days * AROUND);
    this.headDays = el("div", { class: "cal-head-days" });
    this.allDay = el("div", { class: "cal-allday-days" });
    this.hours = el("div", { class: "cal-hours", "aria-hidden": "true" }, ...Array.from({ length: 24 }, (_, h) => el("div", { class: "cal-hour", style: { top: `${h * HOUR}px` } }, h ? clock(h * 60).replace(/^0/, "") : "")));
    this.body = el("div", { class: "cal-days", style: { height: `${24 * HOUR}px` } });
    this.canvas = el(
      "div",
      { class: "cal-canvas" },
      el("div", { class: "cal-head" }, el("div", { class: "cal-corner" }), this.headDays),
      el("div", { class: "cal-allday" }, el("div", { class: "cal-corner cal-allday-label" }, "all day"), this.allDay),
      el("div", { class: "cal-body" }, this.hours, this.body),
    );
    this.scroller = el("div", { class: "cal-scroll", tabindex: "-1" }, this.canvas);
    this.root = el("div", { class: `cal-grid cal-${view}` }, this.scroller);
    this.scroller.addEventListener("scroll", () => this.scrolled(), { passive: true, signal: this.listening.signal });
    this.root.addEventListener("pointerdown", (e) => this.down(e));
    this.root.addEventListener("pointermove", (e) => this.moveTo(e));
    this.root.addEventListener("pointerup", (e) => this.up(e));
    this.root.addEventListener("pointercancel", () => this.cancel());
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.root);
    this.tick = window.setInterval(() => this.drawNow(), 60_000);
    requestAnimationFrame(() => {
      this.layout();
      this.scroller.scrollTop = Math.max(0, env.startHour * HOUR - HOUR / 2);
    });
  }

  private periodStart(day: Day): Day {
    return period(this.view, day, this.env.weekStart).start;
  }

  /** Where the period on screen starts, among the drawn days. */
  private get windowDays() {
    return this.days * (2 * AROUND + 1);
  }

  private layout() {
    const width = this.scroller.clientWidth - GUTTER;
    if (width <= 0) return;
    this.laidOut = true;
    this.col = width / this.days;
    this.canvas.style.width = `${GUTTER + this.windowDays * this.col}px`;
    this.root.style.setProperty("--col", `${this.col}px`);
    this.draw();
    this.scroller.scrollLeft = daysBetween(this.first, this.anchor) * this.col;
  }

  private anchorDay(): Day {
    return this.anchor;
  }

  goto(day: Day, smooth: boolean) {
    const start = this.view === "3day" ? day : this.periodStart(day);
    const at = daysBetween(this.first, start);
    if (at < this.days || at > this.windowDays - 2 * this.days) {
      // Far off: draw the days around it, and go there at once.
      this.first = addDays(start, -this.days * AROUND);
      this.anchor = start;
      this.draw();
      this.scroller.scrollLeft = this.days * AROUND * this.col;
      this.env.scrolled(start);
      return;
    }
    this.scroller.scrollTo({ left: at * this.col, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  private scrolled() {
    // A scroll up or down can come before the grid has its width, when where it is sideways means nothing yet.
    if (!this.laidOut) return;
    const anchor = addDays(this.first, Math.round(this.scroller.scrollLeft / this.col));
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.env.scrolled(anchor);
    }
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => this.recenter(), 140);
  }

  /** Near either end of what's drawn: draw again around what's on screen, and keep it where it is. */
  private recenter() {
    if (this.drag) return;
    const left = this.scroller.scrollLeft;
    const at = Math.round(left / this.col);
    if (at >= this.days && at <= this.windowDays - 2 * this.days) return;
    const shift = at - this.days * AROUND;
    this.first = addDays(this.first, shift);
    this.draw();
    // Set, not moved by: the browser may already have snapped back to the column it was on.
    this.scroller.scrollLeft = left - shift * this.col;
  }

  redraw() {
    this.draw();
  }

  private dayAt(i: number): Day {
    return addDays(this.first, i);
  }

  private draw() {
    const today = this.env.today();
    const last = this.dayAt(this.windowDays);
    const events = this.env.events(this.first, last) ?? [];
    const focused = this.env.focused();
    // Day names, with each period's first day as where scrolling stops.
    this.headDays.replaceChildren(
      ...Array.from({ length: this.windowDays }, (_, i) => {
        const day = this.dayAt(i);
        const d = new Date(`${day}T12:00:00Z`);
        return el(
          "button",
          { type: "button", class: `cal-dayname${day === today ? " is-today" : ""}`, style: { left: `${i * this.col}px` }, "data-day": day, title: "Show this day's events", onclick: () => this.env.show("agenda", day) },
          el("span", { class: "cal-dow" }, d.toLocaleDateString([], { weekday: "short", timeZone: "UTC" })),
          el("span", { class: "cal-dom" }, String(d.getUTCDate())),
        );
      }),
    );
    // All-day events (and ones a day or longer) as bars across their days, in lanes.
    const long = events.filter(longEvent);
    const lanes: Day[][] = [];
    const bars = long.map((o) => {
      const { startDay, endDay } = localSpan(o);
      const end = o.allDay ? endDay : addDays(endDay, 1);
      const from = Math.max(0, daysBetween(this.first, startDay));
      const to = Math.min(this.windowDays, daysBetween(this.first, end));
      let lane = lanes.findIndex((busy) => !busy.some((d) => d >= this.dayAt(from) && d < this.dayAt(to)));
      if (lane < 0) lane = lanes.push([]) - 1;
      for (let i = from; i < to; i++) lanes[lane].push(this.dayAt(i));
      return el(
        "div",
        {
          class: `cal-bar${o.address === focused ? " is-focused" : ""}${this.env.writable(o) ? "" : " is-readonly"}`,
          style: { left: `${from * this.col + 2}px`, width: `${(to - from) * this.col - 4}px`, top: `${lane * LANE}px`, "--event": this.env.color(o) },
          "data-address": o.address,
          role: "button",
          tabindex: "-1",
          title: o.title,
        },
        o.title || "(No title)",
      );
    });
    this.allDay.replaceChildren(...bars);
    this.allDay.style.height = `${Math.max(1, lanes.length) * LANE + 4}px`;
    // Columns of hours, with each day's timed events side by side where they overlap.
    const columns: HTMLElement[] = [];
    const shown: Array<{ o: Occurrence; day: Day; start: number }> = [];
    for (let i = 0; i < this.windowDays; i++) {
      const day = this.dayAt(i);
      const snapStart = this.view === "3day" || weekday(day) === this.env.weekStart;
      const spans = events
        .filter((o) => !longEvent(o))
        .flatMap((o) => {
          const s = localSpan(o);
          if (day < s.startDay || day > s.endDay || (day === s.endDay && s.end === 0 && s.startDay !== s.endDay)) return [];
          return [{ id: o.address, o, start: day === s.startDay ? s.start : 0, end: day === s.endDay ? Math.max(s.end, day === s.startDay ? s.start : 0) : 24 * 60 }];
        });
      const placed = placeDay(spans);
      const nodes = placed.map((p) => {
        const o = spans.find((s) => s.id === p.id)!.o;
        shown.push({ o, day, start: p.start });
        const height = Math.max(p.end - p.start, 25) * (HOUR / 60);
        return el(
          "div",
          {
            class: `cal-event${o.address === focused ? " is-focused" : ""}${this.env.writable(o) ? "" : " is-readonly"}${height < 34 ? " is-short" : ""}`,
            style: { top: `${(p.start / 60) * HOUR}px`, height: `${height - 2}px`, left: `calc(${(p.column / p.columns) * 100}% + 1px)`, width: `calc(${100 / p.columns}% - 3px)`, "--event": this.env.color(o) },
            "data-address": o.address,
            role: "button",
            tabindex: "-1",
            title: `${o.title || "(No title)"}${o.location ? ` · ${o.location}` : ""}`,
          },
          el("span", { class: "cal-event-title" }, o.title || "(No title)"),
          el("span", { class: "cal-event-time" }, `${timeLabel(o.start)}${o.location ? ` · ${o.location}` : ""}`),
          this.env.writable(o) ? el("span", { class: "cal-resize", "aria-hidden": "true" }) : null,
        );
      });
      // A day keeps its column from one drawing to the next: columns are where scrolling stops, and
      // a browser that loses the one it stopped on snaps somewhere else.
      const column = this.columns.get(day) ?? el("div", { "data-day": day });
      column.className = `cal-day${day === today ? " is-today" : ""}${snapStart ? " is-snap" : ""}`;
      Object.assign(column.style, { left: `${i * this.col}px`, width: `${this.col}px` });
      column.replaceChildren(...nodes);
      columns.push(column);
    }
    const left = this.scroller.scrollLeft;
    for (const [day, column] of this.columns) if (!columns.includes(column)) (column.remove(), this.columns.delete(day));
    for (const column of columns) {
      this.columns.set(column.dataset.day!, column);
      if (column.parentElement !== this.body) this.body.append(column);
    }
    for (const stray of [...this.body.children]) if (!columns.includes(stray as HTMLElement)) stray.remove();
    if (this.scroller.scrollLeft !== left) this.scroller.scrollLeft = left;
    this.onScreen = [...long, ...shown.sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start).map((s) => s.o)];
    this.drawNow();
  }

  private drawNow() {
    this.body.querySelector(".cal-now")?.remove();
    const now = new Date();
    const column = this.body.querySelector<HTMLElement>(`.cal-day[data-day="${this.env.today()}"]`);
    column?.append(el("div", { class: "cal-now", style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR}px` }, "aria-hidden": "true" }));
  }

  visible(): Occurrence[] {
    const anchor = this.anchorDay();
    const end = addDays(anchor, this.days);
    return [...new Map(this.onScreen.filter((o) => {
      const s = localSpan(o);
      return s.startDay < end && (o.allDay ? s.endDay > anchor : s.endDay >= anchor);
    }).map((o) => [o.address, o])).values()];
  }

  reveal(address: string) {
    const node = this.body.querySelector<HTMLElement>(`.cal-event[data-address="${CSS.escape(address)}"]`);
    if (!node) return;
    const top = node.offsetTop;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop + 40 || top > this.scroller.scrollTop + view - 80) this.scroller.scrollTop = Math.max(0, top - view / 3);
    const day = node.closest<HTMLElement>(".cal-day")?.dataset.day;
    if (day && (day < this.anchorDay() || day >= addDays(this.anchorDay(), this.days))) this.goto(day, true);
  }

  // ---------------------------------------------------------------- pointer

  private minutesAt(e: PointerEvent): number {
    return ((e.clientY - this.body.getBoundingClientRect().top) / HOUR) * 60;
  }

  private dayIndexAt(e: PointerEvent): number {
    return Math.floor((e.clientX - this.body.getBoundingClientRect().left) / this.col);
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const event = target.closest<HTMLElement>(".cal-event, .cal-bar");
    const inBody = this.body.contains(target);
    const inAllDay = this.allDay.contains(target) || target.closest(".cal-allday");
    if (!event && !inBody && !inAllDay) return;
    const o = event ? this.onScreen.find((x) => x.address === event.dataset.address) : undefined;
    this.press = {
      x: e.clientX,
      y: e.clientY,
      pointer: e.pointerId,
      target: event ? "event" : inAllDay ? "allday" : "empty",
      o,
      node: event ?? undefined,
      day: this.dayIndexAt(e),
      minutes: this.minutesAt(e),
      edge: target.classList.contains("cal-resize"),
    };
  }

  private moveTo(e: PointerEvent) {
    const p = this.press;
    if (!p || e.pointerId !== p.pointer) return;
    if (!this.drag) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < SLOP) return;
      if (p.target === "event" && (!p.o || !this.env.writable(p.o))) return;
      this.root.setPointerCapture(e.pointerId);
      this.drag = this.startDrag(p);
      if (!this.drag) return;
      this.root.classList.add("is-dragging");
    }
    const d = this.drag;
    const minutes = this.minutesAt(e);
    const day = Math.max(0, Math.min(this.windowDays - 1, this.dayIndexAt(e)));
    if (d.kind === "create") {
      const { start, end } = dragRange(d.from, minutes);
      d.to = minutes;
      this.ghostAt(d.ghost, d.day, start, end);
    } else if (d.kind === "move") {
      const length = d.end - d.start;
      const start = Math.max(0, Math.min(24 * 60 - 15, snap(minutes - d.grab)));
      d.start = start;
      d.end = start + length;
      d.day = day;
      this.ghostAt(d.node, day, start, d.end);
    } else if (d.kind === "resize") {
      d.end = Math.max(d.start + 15, Math.min(24 * 60, snap(minutes)));
      this.ghostAt(d.node, d.day, d.start, d.end);
    } else if (d.kind === "moveAllDay") {
      d.shift = day - d.grabDay;
      d.node.style.transform = `translateX(${d.shift * this.col}px)`;
    }
  }

  private startDrag(p: NonNullable<TimeGrid["press"]>): Drag | null {
    if (p.target === "empty") {
      const ghost = el("div", { class: "cal-event cal-ghost" }, el("span", { class: "cal-event-title" }, "New event"));
      this.body.append(ghost);
      return { kind: "create", day: p.day, from: p.minutes, to: p.minutes, ghost };
    }
    if (!p.o || !p.node) return null;
    if (p.node.classList.contains("cal-bar")) return { kind: "moveAllDay", o: p.o, node: p.node, grabDay: p.day, shift: 0 };
    const s = localSpan(p.o);
    const day = p.day;
    const start = s.startDay === this.dayAt(day) ? s.start : 0;
    const end = s.endDay === this.dayAt(day) ? s.end : 24 * 60;
    // Dragged out of its column, so it sits above the others while it moves.
    this.body.append(p.node);
    p.node.classList.add("is-moving");
    return { kind: p.edge ? "resize" : "move", o: p.o, node: p.node, grab: p.minutes - start, day, start, end, startDay: day };
  }

  /** Put a block over a day's column, from one time to another. */
  private ghostAt(node: HTMLElement, day: number, start: number, end: number) {
    Object.assign(node.style, { left: `${day * this.col + 1}px`, width: `${this.col - 4}px`, top: `${(start / 60) * HOUR}px`, height: `${((end - start) / 60) * HOUR - 2}px` });
    const time = node.querySelector(".cal-event-time") ?? node.appendChild(el("span", { class: "cal-event-time" }));
    time.textContent = `${clock(start)} – ${clock(end)}`;
  }

  private up(e: PointerEvent) {
    const p = this.press;
    this.press = null;
    if (!p || e.pointerId !== p.pointer) return;
    const d = this.drag;
    this.drag = null;
    this.root.classList.remove("is-dragging");
    if (!d) {
      // A click: open an event, or make one where you clicked.
      if (p.o && p.node) return this.env.open(p.o, p.node.getBoundingClientRect());
      if (p.target === "allday") {
        const day = this.dayAt(p.day);
        return this.env.create({ allDay: true, startDay: day, endDay: addDays(day, 1) }, new DOMRect(e.clientX, e.clientY, 1, 1));
      }
      if (p.target === "empty") {
        const start = Math.min(24 * 60 - 30, Math.floor(p.minutes / 15) * 15);
        const ghost = el("div", { class: "cal-event cal-ghost" }, el("span", { class: "cal-event-title" }, "New event"));
        this.body.append(ghost);
        this.ghostAt(ghost, p.day, start, start + 30);
        return this.env.create({ allDay: false, day: this.dayAt(p.day), start, end: start + 30 }, ghost.getBoundingClientRect(), ghost);
      }
      return;
    }
    if (d.kind === "create") {
      const { start, end } = dragRange(d.from, d.to);
      return this.env.create({ allDay: false, day: this.dayAt(d.day), start, end }, d.ghost.getBoundingClientRect(), d.ghost);
    }
    if (d.kind === "moveAllDay") {
      const s = localSpan(d.o);
      if (!d.shift) return this.redraw();
      return this.env.move(d.o, { allDay: true, startDay: addDays(s.startDay, d.shift), endDay: addDays(s.endDay, d.shift) }, d.node.getBoundingClientRect());
    }
    const s = localSpan(d.o);
    const dayShift = d.day - d.startDay;
    const startDay = addDays(s.startDay, dayShift);
    // An event that runs past midnight keeps its end day; one within a day ends on its new day.
    const endDay = s.startDay === s.endDay ? startDay : addDays(s.endDay, dayShift);
    const start = d.kind === "resize" ? (s.startDay === this.dayAt(d.startDay) ? s.start : 0) : d.start;
    const end = d.kind === "resize" ? d.end : s.startDay === s.endDay ? d.end : s.end;
    this.env.move(d.o, { allDay: false, startDay, start, endDay: d.kind === "resize" ? this.dayAt(d.day) : endDay, end }, d.node.getBoundingClientRect());
  }

  private cancel() {
    this.press = null;
    if (this.drag) {
      this.drag = null;
      this.root.classList.remove("is-dragging");
      this.redraw();
    }
  }

  destroy() {
    this.listening.abort();
    this.resize.disconnect();
    clearInterval(this.tick);
    clearTimeout(this.settle);
    this.root.remove();
  }
}
