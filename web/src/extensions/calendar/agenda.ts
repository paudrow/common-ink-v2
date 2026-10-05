// The agenda: days with events, in order from a day, as a list that scrolls down for as long as you
// like (more days load as you near the end). Today shows even when it's empty.
import type { Occurrence } from "common-ink/calendar";
import { el } from "./dom.ts";
import { addDays, type Day } from "./model.ts";
import { localSpan, timeLabel, type CalendarView, type ViewEnv } from "./views.ts";

const CHUNK = 30;

export class Agenda implements CalendarView {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private days = CHUNK;
  private onScreen: Occurrence[] = [];

  constructor(
    private env: ViewEnv,
    private from: Day,
  ) {
    this.list = el("div", { class: "cal-agenda-list" });
    this.root = el("div", { class: "cal-agenda", tabindex: "-1" }, this.list);
    this.root.addEventListener("scroll", () => {
      if (this.root.scrollTop + this.root.clientHeight > this.root.scrollHeight - 400) {
        this.days += CHUNK;
        this.draw();
      }
    }, { passive: true });
    this.root.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".cal-row");
      const o = row && this.onScreen.find((x) => x.address === row.dataset.address);
      if (o && row) this.env.open(o, row.getBoundingClientRect());
    });
    requestAnimationFrame(() => this.draw());
  }

  goto(day: Day) {
    this.from = day;
    this.days = CHUNK;
    this.root.scrollTop = 0;
    this.draw();
    this.env.scrolled(day);
  }

  redraw() {
    this.draw();
  }

  private draw() {
    const today = this.env.today();
    const to = addDays(this.from, this.days);
    const events = this.env.events(this.from, to) ?? [];
    const focused = this.env.focused();
    const days = new Map<Day, Occurrence[]>();
    for (const o of events) {
      const s = localSpan(o);
      const day = s.startDay < this.from ? this.from : s.startDay;
      days.set(day, [...(days.get(day) ?? []), o]);
    }
    if (today >= this.from && today < to && !days.has(today)) days.set(today, []);
    this.onScreen = [];
    const sections = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => {
      const sorted = list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
      this.onScreen.push(...sorted);
      const d = new Date(`${day}T12:00:00Z`);
      return el(
        "section",
        { class: `cal-agenda-day${day === today ? " is-today" : ""}`, "data-day": day },
        el("h3", {}, el("span", { class: "cal-agenda-dom" }, String(d.getUTCDate())), d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })),
        sorted.length
          ? el(
              "div",
              {},
              ...sorted.map((o) =>
                el(
                  "div",
                  { class: `cal-row${o.address === focused ? " is-focused" : ""}`, style: { "--event": this.env.color(o) }, "data-address": o.address, role: "button", tabindex: "-1" },
                  el("span", { class: "cal-row-when" }, o.allDay ? "All day" : `${timeLabel(o.start)} – ${timeLabel(o.end)}`),
                  el("span", { class: "cal-dot" }),
                  el("span", { class: "cal-row-what" }, `${o.title || "(No title)"}${o.series ? " ↻" : ""}`),
                  o.location ? el("span", { class: "cal-row-where" }, o.location) : null,
                ),
              ),
            )
          : el("p", { class: "cal-empty" }, "Nothing today"),
      );
    });
    this.list.replaceChildren(...sections, el("p", { class: "cal-agenda-end" }, `Through ${new Date(`${addDays(to, -1)}T12:00:00Z`).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}; scroll for more`));
  }

  visible(): Occurrence[] {
    return this.onScreen;
  }

  reveal(address: string) {
    this.root.querySelector<HTMLElement>(`[data-address="${CSS.escape(address)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  destroy() {
    this.root.remove();
  }
}
