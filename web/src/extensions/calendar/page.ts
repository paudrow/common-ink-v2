// The Calendar view in a tab: a toolbar (today, back and on, the dates on screen, the views, which
// calendars show) over one of the views. It owns the events on screen, the keyboard, the editor, and
// every write; the views draw and say what you did.
//
// Keys, while the view has focus (by the character typed, so any keyboard layout):
//   h l (or ← →)  back and on a period     t  today            n  new event
//   j k           next and previous event  Enter  open it      Delete  delete it
//   a 3 w m y     agenda, 3 days, week, month, year
import type { Calendar, Occurrence, Scope } from "common-ink/calendar";
import { wallTimeAt } from "common-ink/calendar";
import type { ExtensionContext } from "../../extension-api.ts";
import type { EventFound } from "../../../../worker/src/operations.ts";
import { Agenda } from "./agenda.ts";
import { el, icon } from "./dom.ts";
import { chooseScope, closePopover, openEditor, type Draft } from "./editor.ts";
import { TimeGrid } from "./grid.ts";
import { addDays, clock, dayOf, gridDays, midnight, step, title, VIEW_NAMES, VIEWS, type Day, type View } from "./model.ts";
import { MonthView, YearView } from "./months.ts";
import { localSpan, type CalendarView, type Moved, type Slot, type ViewEnv } from "./views.ts";

/** Google's event colours, by colorId. */
const EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};

/** The person's time zone: new events are made in it. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The zone an edit of an event keeps: its own, floating (null) if it floats, or the person's for an all-day event given times. */
const zoneFor = (o: Occurrence): string | null => (o.allDay ? ZONE : (o.timeZone ?? null));

/** A calendar drawn in a note (the ::calendar embed): one view, perhaps a few calendars, a height. */
export interface Embedded {
  view: Exclude<View, "year">;
  /** How many days an agenda shows. */
  days: number;
  /** Only these calendars, by id; all of them when empty. */
  calendars: string[];
  /** Its height in pixels, for the grids and the month. */
  height: number;
}

/** What the view keeps between visits, in its state file: the view, and the calendars you hid. */
export interface PageState {
  view?: View;
  hidden?: string[];
}

/** A local day and time as a wall time in another zone, for an event that keeps its own. */
function inZone(day: Day, minutes: number, zone: string | undefined): string {
  const local = `${day}T${clock(minutes)}`;
  if (!zone || zone === ZONE) return local;
  const at = new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), Math.floor(minutes / 60), minutes % 60).getTime();
  return wallTimeAt(at, zone).slice(0, 16);
}

const minutesOf = (time: string) => +time.slice(0, 2) * 60 + +time.slice(3, 5);

/** An event's times, which change together: a new start alone would keep its length instead of its end. */
const TIMES = ["allDay", "start", "end", "timeZone"];

/**
 * What a save changes: the fields that differ from the event as the editor opened it, and its times
 * together if any of them did. Sending the rest as they were would undo what someone else changed
 * meanwhile, while the editor was open or the save waited offline.
 */
function changedFrom<T extends Record<string, unknown>>(opened: T, saved: T): Partial<T> {
  const differs = (key: string) => JSON.stringify(opened[key]) !== JSON.stringify(saved[key]);
  const timesMoved = TIMES.some(differs);
  return Object.fromEntries(Object.entries(saved).filter(([key]) => (TIMES.includes(key) ? timesMoved : differs(key)))) as Partial<T>;
}

export class CalendarPage {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private heading: HTMLElement;
  private switcher: HTMLElement;
  private renderer: CalendarView | null = null;
  private view: View;
  private anchor: Day;
  /** Where a glide the keys or buttons asked for is going, until it's there: so h and l pressed quickly add up. */
  private gliding: Day | null = null;
  private calendars: Calendar[] = [];
  private hidden: Set<string> | null;
  private focus: string | null = null;
  private cache: { from: Day; to: Day; events: Occurrence[] } | null = null;
  private wanted: { from: Day; to: Day } | null = null;
  private loading = false;
  private weekStart: number;
  private startHour: number;

  constructor(
    private ctx: ExtensionContext,
    state: PageState,
    /** An event to show and open, from a click on its chip in a note. */
    reveal?: { address: string; day: Day },
    /** Drawn in a note: one view, no state kept, and a button to open the whole calendar. */
    private embedded?: Embedded,
  ) {
    this.weekStart = ctx.settings.get<string>("calendar.weekStart") === "sunday" ? 6 : 0;
    this.startHour = ctx.settings.get<number>("calendar.startHour") ?? 7;
    this.view = state.view && VIEWS.includes(state.view) ? state.view : ((ctx.settings.get<View>("calendar.view") as View) ?? "week");
    this.hidden = state.hidden ? new Set(state.hidden) : null;
    this.anchor = reveal?.day ?? this.today();
    if (reveal) {
      if (this.view === "agenda" || this.view === "year") this.view = "week";
      this.focus = reveal.address;
      this.openWhenLoaded = reveal.address;
    }
    this.heading = el("h2", { class: "cal-title-text", "aria-live": "polite" });
    this.switcher = el("div", { class: "cal-switch", role: "group", "aria-label": "View" });
    if (embedded) this.view = embedded.view;
    const toolbar = el(
      "div",
      { class: "cal-toolbar" },
      el("button", { type: "button", class: "qw-btn", title: "Today (t)", onclick: () => this.goto(this.today(), true) }, "Today"),
      el("button", { type: "button", class: "icon-btn", title: "Back (h)", onclick: () => this.stepBy(-1) }, icon("left", 18)),
      el("button", { type: "button", class: "icon-btn", title: "On (l)", onclick: () => this.stepBy(1) }, icon("right", 18)),
      this.heading,
      el("span", { class: "spacer" }),
      ...(embedded
        ? [el("button", { type: "button", class: "icon-btn", title: "Open the calendar", onclick: () => this.openWhole() }, icon("open", 16))]
        : [this.switcher, el("button", { type: "button", class: "qw-btn cal-calendars", title: "Which calendars show", onclick: (e: MouseEvent) => this.chooseCalendars(e.currentTarget as HTMLElement) }, icon("layers", 15), "Calendars")]),
    );
    this.body = el("div", { class: "cal-body-host" });
    this.root = el("div", { class: `cal-page${embedded ? " is-embed" : ""}`, tabindex: "0", "aria-label": "Calendar" }, toolbar, this.body);
    if (embedded) this.setEmbedded(embedded);
    this.root.addEventListener("keydown", (e) => this.key(e));
    void this.loadCalendars();
    this.show(this.view, this.anchor);
  }

  private today(): Day {
    return dayOf(new Date());
  }

  // ---------------------------------------------------------------- data

  private async loadCalendars() {
    try {
      this.calendars = await this.ctx.data.calendar.calendars();
    } catch {
      this.calendars = [];
    }
    this.hidden ??= new Set(this.calendars.filter((c) => c.selected === false).map((c) => c.id));
    this.renderer?.redraw();
  }

  private shown(o: Occurrence) {
    if (this.embedded?.calendars.length) return this.embedded.calendars.includes(o.calendar);
    return !this.hidden?.has(o.calendar);
  }

  /** New arguments for a calendar in a note: drawn again in the same place, the period on screen kept. */
  setEmbedded(embedded: Embedded) {
    const changed = !this.embedded || this.embedded.view !== embedded.view || this.embedded.days !== embedded.days;
    this.embedded = embedded;
    this.root.style.setProperty("--embed-height", `${embedded.height}px`);
    this.root.classList.toggle("is-list", embedded.view === "agenda");
    if (changed && this.renderer) this.show(embedded.view, this.anchor);
    else this.renderer?.redraw();
  }

  /** The whole calendar, in a tab, from a calendar in a note. */
  openWhole: () => void = () => {};

  /** Events between two days, from what's loaded; anything not loaded yet is asked for, and the view drawn again once it's in. */
  private events(from: Day, to: Day): Occurrence[] | null {
    const c = this.cache;
    const covered = c && c.from <= from && c.to >= to;
    if (!covered) this.load(from, to);
    if (!c) return null;
    return c.events.filter((o) => {
      if (!this.shown(o)) return false;
      const s = localSpan(o);
      return s.startDay < to && (o.allDay ? s.endDay > from : s.endDay >= from);
    });
  }

  private load(from: Day, to: Day) {
    this.wanted = { from: addDays(from, -7), to: addDays(to, 7) };
    if (this.loading) return;
    this.loading = true;
    void (async () => {
      while (this.wanted) {
        const { from: f, to: t } = this.wanted;
        this.wanted = null;
        try {
          const events = await this.ctx.data.calendar.events(midnight(f), midnight(t));
          this.cache = { from: f, to: t, events };
        } catch (err) {
          this.notice((err as Error).message);
          break;
        }
      }
      this.loading = false;
      this.renderer?.redraw();
      if (this.focusLater) {
        const n = this.focusLater;
        this.focusLater = 0;
        this.focusBy(n);
      }
      const opening = this.openWhenLoaded && this.cache?.events.find((o) => o.address === this.openWhenLoaded);
      if (opening) {
        this.openWhenLoaded = null;
        this.renderer?.reveal(opening.address);
        const node = this.root.querySelector<HTMLElement>(`[data-address="${CSS.escape(opening.address)}"]`);
        void this.open(opening, (node ?? this.root).getBoundingClientRect());
      }
    })();
  }

  /** Records changed (here, by sync, an agent or another tab): load what's on screen again. */
  refresh() {
    if (this.cache) this.load(addDays(this.cache.from, 7), addDays(this.cache.to, -7));
    void this.loadCalendars();
  }

  private color(o: Occurrence): string {
    return (o.colorId && EVENT_COLORS[o.colorId]) || this.calendars.find((c) => c.id === o.calendar)?.color || "#4f6bd8";
  }

  private writable(o: Occurrence): boolean {
    return this.calendars.find((c) => c.id === o.calendar)?.writable ?? false;
  }

  // ---------------------------------------------------------------- views

  private env(): ViewEnv {
    return {
      weekStart: this.weekStart,
      startHour: this.startHour,
      today: () => this.today(),
      events: (from, to) => this.events(from, to),
      color: (o) => this.color(o),
      writable: (o) => this.writable(o),
      focused: () => this.focus,
      open: (o, at) => void this.open(o, at),
      create: (slot, at, ghost) => this.create(slot, at, ghost),
      move: (o, to, at) => void this.move(o, to, at),
      scrolled: (anchor) => {
        this.anchor = anchor;
        if (anchor === this.gliding) this.gliding = null;
        this.heading.textContent = title(this.view, this.gliding ?? anchor, this.weekStart);
      },
      show: (view, day) => this.show(view, day),
    };
  }

  /** Show a view at a day. */
  show(view: View, day: Day) {
    closePopover();
    this.view = view;
    this.anchor = day;
    this.renderer?.destroy();
    const env = this.env();
    this.renderer = view === "agenda" ? new Agenda(env, day, this.embedded?.days) : view === "month" ? new MonthView(env, day) : view === "year" ? new YearView(env, day) : new TimeGrid(env, view, day);
    this.body.replaceChildren(this.renderer.root);
    this.heading.textContent = title(view, day, this.weekStart);
    this.switcher.replaceChildren(
      ...VIEWS.map((v) => el("button", { type: "button", "aria-pressed": String(v === view), title: `${VIEW_NAMES[v].label} (${VIEW_NAMES[v].key})`, onclick: () => this.show(v, this.anchor) }, VIEW_NAMES[v].label)),
    );
    if (this.embedded) return;
    void this.ctx.state.get().then((s) => {
      const kept = (s ?? {}) as PageState;
      if (kept.view !== view) void this.ctx.state.set({ ...kept, view });
    });
  }

  private goto(day: Day, smooth: boolean) {
    this.gliding = smooth ? day : null;
    this.heading.textContent = title(this.view, day, this.weekStart);
    this.renderer?.goto(day, smooth);
  }

  private stepBy(n: number) {
    const from = this.gliding ?? this.anchor;
    // The time grid steps by what's on screen: 3 days, or a week; an agenda in a note, by its days.
    if (this.embedded?.view === "agenda") return this.goto(addDays(from, n * this.embedded.days), false);
    this.goto(this.view === "3day" || this.view === "week" ? addDays(from, n * gridDays(this.view)) : step(this.view, from, n, this.weekStart), true);
  }

  // ---------------------------------------------------------------- keys

  private key(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable], .cal-pop")) return;
    const handled = this.keyFor(e.key);
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private keyFor(key: string): boolean {
    const view = this.embedded ? undefined : VIEWS.find((v) => VIEW_NAMES[v].key === key);
    if (view) return this.show(view, this.anchor), true;
    switch (key) {
      case "h":
      case "ArrowLeft":
        return this.stepBy(-1), true;
      case "l":
      case "ArrowRight":
        return this.stepBy(1), true;
      case "t":
        return this.goto(this.today(), true), true;
      case "j":
      case "ArrowDown":
        return this.focusBy(1), true;
      case "k":
      case "ArrowUp":
        return this.focusBy(-1), true;
      case "Enter": {
        const o = this.focused();
        const node = o && this.root.querySelector<HTMLElement>(`[data-address="${CSS.escape(o.address)}"]`);
        if (o) void this.open(o, (node ?? this.root).getBoundingClientRect());
        return !!o;
      }
      case "n":
        return this.newHere(), true;
      case "Delete":
      case "Backspace": {
        const o = this.focused();
        if (o) void this.remove(o, this.root.getBoundingClientRect());
        return !!o;
      }
    }
    return false;
  }

  private focused(): Occurrence | null {
    return this.renderer?.visible().find((o) => o.address === this.focus) ?? null;
  }

  /** An event to open once what's on screen has loaded (a click on its chip asked). */
  private openWhenLoaded: string | null = null;

  /** j or k pressed while what's on screen was still loading: done once it's in. */
  private focusLater = 0;

  private focusBy(n: number) {
    const list = this.renderer?.visible() ?? [];
    if (!list.length) {
      if (this.loading) this.focusLater = n;
      return;
    }
    const at = list.findIndex((o) => o.address === this.focus);
    const next = list[at < 0 ? (n > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + n))];
    this.focus = next.address;
    this.renderer?.redraw();
    this.renderer?.reveal(next.address);
  }

  /** "n": a new event at the next hour today, if today's on screen, or at the start hour on the first day shown. */
  private newHere() {
    const today = this.today();
    const onScreen = this.view === "agenda" || (today >= this.anchor && today < addDays(this.anchor, this.view === "3day" ? 3 : this.view === "week" ? 7 : 31));
    const now = new Date();
    const start = onScreen ? Math.min(23 * 60, (now.getHours() + 1) * 60) : this.startHour * 60;
    const r = this.root.getBoundingClientRect();
    this.create({ allDay: false, day: onScreen ? today : this.anchor, start, end: start + 30 }, new DOMRect(r.left + r.width / 2 - 170, r.top + 80, 1, 1));
  }

  // ---------------------------------------------------------------- editing

  private draftOf(o: Occurrence): Draft {
    const s = localSpan(o);
    return {
      title: o.title,
      allDay: o.allDay,
      startDay: s.startDay,
      startTime: clock(s.start),
      endDay: o.allDay ? addDays(s.endDay, -1) : s.endDay,
      endTime: clock(s.end),
      calendar: o.calendar,
      location: o.location ?? "",
      description: o.description ?? "",
      recurrence: [],
    };
  }

  /** An event's fields from the form, as the API takes them; times in `zone`, or floating (null) at the person's wall time. */
  private fields(d: Draft, zone: string | null) {
    return {
      title: d.title,
      allDay: d.allDay,
      start: d.allDay ? d.startDay : inZone(d.startDay, minutesOf(d.startTime), zone ?? undefined),
      end: d.allDay ? addDays(d.endDay, 1) : inZone(d.endDay, minutesOf(d.endTime), zone ?? undefined),
      timeZone: d.allDay ? null : zone,
      location: d.location || null,
      description: d.description || null,
      recurrence: d.recurrence.length ? d.recurrence : null,
    };
  }

  private async open(o: Occurrence, at: DOMRect) {
    this.focus = o.address;
    this.renderer?.redraw();
    const found = await this.ctx.data.calendar.event(o.address).catch(() => null);
    const draft = this.draftOf(o);
    draft.recurrence = found?.series?.recurrence ?? found?.event.recurrence ?? [];
    const repeating = !!(o.series ?? found?.event.recurrence);
    const opened = this.fields(draft, zoneFor(o));
    openEditor(at, draft, {
      calendars: this.calendars,
      repeating,
      readOnly: !this.writable(o),
      link: o.link,
      extra: await this.extra(o, found),
      save: async (d, scope) => this.wrote(await this.ctx.data.calendar.update(o.address, changedFrom(opened, this.fields(d, zoneFor(o))), scope)),
      remove: async (scope) => this.wrote(await this.ctx.data.calendar.remove(o.address, scope), `Deleted ${o.title || "the event"}`),
      onClose: () => this.root.focus({ preventScroll: true }),
    }, false);
  }

  /** What's added under an event in its editor (the notes that link to it). Nothing by default. */
  extra: (o: Occurrence, found: EventFound | null) => Promise<HTMLElement | undefined> = async () => undefined;

  private create(slot: Slot, at: DOMRect, ghost?: HTMLElement) {
    const calendar = this.calendars.find((c) => c.primary && c.writable) ?? this.calendars.find((c) => c.writable);
    if (!calendar) {
      ghost?.remove();
      return this.notice("There's no calendar to add events to");
    }
    const draft: Draft = slot.allDay
      ? { title: "", allDay: true, startDay: slot.startDay, startTime: "09:00", endDay: addDays(slot.endDay, -1), endTime: "09:30", calendar: calendar.id, location: "", description: "", recurrence: [] }
      : { title: "", allDay: false, startDay: slot.day, startTime: clock(slot.start), endDay: slot.end >= 24 * 60 ? addDays(slot.day, 1) : slot.day, endTime: clock(slot.end % (24 * 60)), calendar: calendar.id, location: "", description: "", recurrence: [] };
    openEditor(at, draft, {
      calendars: this.calendars,
      repeating: false,
      readOnly: false,
      save: async (d) => {
        const result = await this.ctx.data.calendar.create({ ...this.fields(d, ZONE), title: d.title || "(No title)", calendar: d.calendar });
        this.focus = result.address;
        return this.wrote(result);
      },
      onClose: () => {
        ghost?.remove();
        this.root.focus({ preventScroll: true });
      },
    }, true);
  }

  private async move(o: Occurrence, to: Moved, at: DOMRect) {
    const scope: Scope | null | undefined = o.series ? await chooseScope(at, "Save") : undefined;
    if (scope === null) return this.renderer?.redraw();
    const change = to.allDay
      ? { allDay: true, start: to.startDay, end: to.endDay }
      : { allDay: false, start: inZone(to.startDay, to.start, o.timeZone), end: inZone(to.endDay, to.end, o.timeZone), timeZone: zoneFor(o) };
    try {
      this.wrote(await this.ctx.data.calendar.update(o.address, change, scope));
    } catch (err) {
      this.notice((err as Error).message);
      this.renderer?.redraw();
    }
  }

  private async remove(o: Occurrence, at: DOMRect) {
    if (!this.writable(o)) return this.notice("This calendar can't be changed here");
    const scope: Scope | null | undefined = o.series ? await chooseScope(at, "Delete") : undefined;
    if (scope === null) return;
    this.wrote(await this.ctx.data.calendar.remove(o.address, scope), `Deleted ${o.title || "the event"}`);
  }

  /** After a write: say if it's waiting for its source, and draw what's new. */
  private wrote(result: Awaited<ReturnType<ExtensionContext["data"]["calendar"]["update"]>>, done?: string): boolean {
    if (result.status === "queued" && !result.written.length && !result.deleted.length) this.notice(`Kept in this browser: ${result.error}.`);
    else if (result.status === "queued") this.notice(`Saved here. It goes to your calendar when it can: ${result.error}`);
    else if (done) this.notice(`${done}. History can bring it back.`);
    this.refresh();
    return true;
  }

  private notice(message: string) {
    this.ctx.workbench.notice(message);
  }

  /** Which calendars show: a popover of checkboxes, kept in the view's state. */
  private chooseCalendars(anchor: HTMLElement) {
    closePopover();
    const box = el(
      "div",
      { class: "chip-pop cal-pop cal-which", role: "dialog", tabindex: "-1" },
      el("div", { class: "cal-pop-title" }, "Calendars"),
      ...this.calendars.map((c) => {
        const box = el("input", { type: "checkbox", checked: !this.hidden?.has(c.id) });
        box.addEventListener("change", () => {
          this.hidden ??= new Set();
          if (box.checked) this.hidden.delete(c.id);
          else this.hidden.add(c.id);
          void this.ctx.state.get().then((s) => this.ctx.state.set({ ...((s ?? {}) as PageState), hidden: [...this.hidden!] }));
          this.renderer?.redraw();
        });
        return el("label", { class: "fp-item" }, box, el("span", { class: "cal-swatch", style: { "--calendar": c.color } }), el("span", {}, c.title), c.writable ? null : el("span", { class: "cal-muted" }, "read-only"));
      }),
    );
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, r.right - box.offsetWidth)}px`;
    box.style.top = `${r.bottom + 6}px`;
    const close = (e: PointerEvent) => {
      if (box.contains(e.target as Node)) return;
      box.remove();
      document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true));
    box.addEventListener("keydown", (e) => e.key === "Escape" && (box.remove(), this.root.focus()));
    box.focus();
  }

  destroy() {
    closePopover();
    this.renderer?.destroy();
  }
}
