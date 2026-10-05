// The event editor: a popover by the event with its title, times, calendar, place, notes and repeat,
// and the chooser a repeating event's edits and deletes ask first ("This event", "This and following
// events", "All events", as Google asks). Repeat has quick picks and the whole rule as a form, like a
// task's repeat; both write RRULE lines.
import type { Calendar, Scope } from "common-ink/calendar";
import { DAY_NAMES, MONTH_NAMES, nth, parseRule, ruleLabel, toRRule } from "common-ink/recurrence";
import type { Rule } from "../../../../worker/src/recurrence.ts";
import { el, icon } from "./dom.ts";
import { addDays, type Day, weekday } from "./model.ts";

/** What the editor edits: an event's fields as the form shows them. */
export interface Draft {
  title: string;
  allDay: boolean;
  startDay: Day;
  /** "09:00". */
  startTime: string;
  /** For an all-day event, its last day (the form says "to Oct 9", not "to the 10th"). */
  endDay: Day;
  endTime: string;
  calendar: string;
  location: string;
  description: string;
  /** RRULE, EXDATE and RDATE lines; empty for one that doesn't repeat. */
  recurrence: string[];
}

export interface EditorEnv {
  calendars: Calendar[];
  /** Save the draft; a repeating event's save comes with the scope chosen. True when it's done. */
  save(draft: Draft, scope: Scope | undefined): Promise<boolean>;
  remove?(scope: Scope | undefined): Promise<boolean>;
  /** An occurrence of a repeating event: saving and deleting ask which ones first. */
  repeating: boolean;
  readOnly: boolean;
  /** Where it opens in its source (Google), if it has a page there. */
  link?: string;
  /** More to show at the bottom, such as the notes that link here. */
  extra?: HTMLElement;
  onClose(): void;
}

/** Put a popover by a rectangle: to its right if there's room, else to its left, else below; always on screen. */
export function place(box: HTMLElement, at: DOMRect) {
  const { innerWidth: w, innerHeight: h } = window;
  const r = box.getBoundingClientRect();
  let left = at.right + 8;
  if (left + r.width > w - 8) left = at.left - r.width - 8;
  if (left < 8) left = Math.min(Math.max(8, at.left), w - r.width - 8);
  // Beside what it's for, but on screen, even when that's scrolled partly out of view.
  const top = Math.max(8, Math.min(at.top, h - r.height - 8));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

let open: { close(): void } | null = null;

/** Close the editor or chooser that's open, if one is. */
export const closePopover = () => open?.close();

/** A popover of our own: one at a time, closed by Escape or a click outside. */
function popover(className: string, at: DOMRect, onClose: () => void, ...children: HTMLElement[]) {
  open?.close();
  const box = el("div", { class: `chip-pop cal-pop ${className}`, role: "dialog", tabindex: "-1" }, ...children);
  document.body.append(box);
  place(box, at);
  // It grows as its parts draw (a rule's form, a long summary): keep it on screen as it does.
  const grown = new ResizeObserver(() => place(box, at));
  grown.observe(box);
  const outside = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    box.remove();
    grown.disconnect();
    document.removeEventListener("pointerdown", outside, true);
    box.removeEventListener("keydown", keys);
    if (open === handle) open = null;
    onClose();
  };
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
  box.addEventListener("keydown", keys);
  const handle = { close };
  open = handle;
  return { box, close, place: () => place(box, at) };
}

/**
 * Which occurrences of a repeating event an edit or a delete is for. Resolves to null if you close it.
 * Keys 1, 2 and 3 choose, as do the arrows and Enter.
 */
export function chooseScope(at: DOMRect, verb: "Save" | "Delete"): Promise<Scope | null> {
  return new Promise((resolve) => {
    let chosen: Scope | null = null;
    const pick = (scope: Scope) => () => {
      chosen = scope;
      close();
    };
    const items = ([["this", "This event"], ["following", "This and following events"], ["all", "All events"]] as const).map(([scope, label], i) =>
      el("button", { type: "button", class: "fp-item", "data-scope": scope, onclick: pick(scope) }, el("span", {}, label), el("kbd", {}, String(i + 1))),
    );
    const { box, close } = popover("cal-scope", at, () => resolve(chosen), el("div", { class: "cal-pop-title" }, `${verb} a repeating event`), el("div", { class: "fp-list" }, ...items));
    box.addEventListener("keydown", (e) => {
      const n = ["1", "2", "3"].indexOf(e.key);
      if (n >= 0) return items[n].click();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "j") items[(at + 1) % 3].focus();
      else if (e.key === "ArrowUp" || e.key === "k") items[(at + 2) % 3].focus();
      else return;
      e.preventDefault();
    });
    items[0].focus();
  });
}

// ------------------------------------------------------------------ repeat

const RFC_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const blank = (freq: Rule["freq"]): Rule => ({ freq, interval: 1, from: "due", byDay: [], byMonthDay: [], byMonth: [], byYearDay: [] });

/** The rule in a series' lines, with its UNTIL as a day (the form ends on a day). */
function ruleOf(lines: string[]): Rule | null {
  const rrule = lines.find((l) => /^RRULE:/i.test(l));
  return rrule ? parseRule(rrule) : null;
}

/** A rule as an RRULE line: UNTIL as the end of its day in UTC for an event with times, as iCalendar wants. */
function rruleOf(r: Rule, allDay: boolean): string {
  const line = toRRule({ ...r, until: undefined });
  if (!r.until) return line;
  return `${line};UNTIL=${r.until.replace(/-/g, "")}${allDay ? "" : "T235959Z"}`;
}

/** The quick picks for a series starting on `day`: what Google offers. */
function picks(day: Day): Array<[string, Rule | null]> {
  const d = weekday(day);
  const date = +day.slice(8, 10);
  const n = Math.ceil(date / 7);
  const last = +addDays(day, 7).slice(5, 7) !== +day.slice(5, 7);
  return [
    ["Doesn't repeat", null],
    ["Daily", blank("day")],
    ["Every weekday (Monday to Friday)", { ...blank("week"), byDay: [0, 1, 2, 3, 4].map((day) => ({ n: 0, day })) }],
    [`Weekly on ${DAY_NAMES[d]}`, { ...blank("week"), byDay: [{ n: 0, day: d }] }],
    [`Monthly on the ${nth(n <= 4 ? n : -1)} ${DAY_NAMES[d]}`, { ...blank("month"), byDay: [{ n: n <= 4 ? n : -1, day: d }] }],
    ...(last && n <= 4 ? [[`Monthly on the last ${DAY_NAMES[d]}`, { ...blank("month"), byDay: [{ n: -1, day: d }] }] as [string, Rule]] : []),
    [`Monthly on day ${date}`, { ...blank("month"), byMonthDay: [date] }],
    [`Yearly on ${MONTH_NAMES[+day.slice(5, 7) - 1]} ${date}`, { ...blank("year"), byMonth: [+day.slice(5, 7)], byMonthDay: [date] }],
  ];
}

const same = (a: Rule | null, b: Rule | null) => (a && b ? toRRule(a) === toRRule(b) : a === b);

/** The repeat control: a select of quick picks and "Custom…", which opens the rule as a form below it. */
function repeatControl(draft: Draft, changed: () => void, relayout: () => void): HTMLElement {
  const others = draft.recurrence.filter((l) => !/^RRULE:/i.test(l));
  let rule = ruleOf(draft.recurrence);
  const write = () => {
    draft.recurrence = rule ? [rruleOf(rule, draft.allDay), ...others] : [];
    summary.textContent = rule ? ruleLabel(rule, true) + (rule.until ? `, until ${rule.until}` : rule.count ? `, ${rule.count} times` : "") : "";
    changed();
  };
  const options = picks(draft.startDay);
  const select = el("select", { class: "qw-select cal-repeat", "aria-label": "Repeat" }, ...options.map(([label], i) => el("option", { value: String(i) }, label)), el("option", { value: "custom" }, "Custom…"));
  const index = options.findIndex(([, r]) => same(r, rule && { ...rule }));
  const form = el("div", { class: "cal-rule" });
  const summary = el("div", { class: "cal-rule-summary", "aria-live": "polite" });
  select.value = index >= 0 ? String(index) : "custom";
  const showForm = () => {
    form.replaceChildren(...ruleForm());
    relayout();
  };
  select.addEventListener("change", () => {
    if (select.value === "custom") {
      rule ??= blank("week");
      showForm();
    } else {
      rule = options[+select.value][1] && structuredClone(options[+select.value][1]);
      form.replaceChildren();
      relayout();
    }
    write();
  });
  const ruleForm = (): HTMLElement[] => {
    const r = rule!;
    const n = el("input", { type: "number", class: "chip-n", min: "1", max: "99", value: String(r.interval), "aria-label": "Every how many" });
    n.addEventListener("input", () => {
      const v = Math.round(+n.value);
      if (v >= 1 && v <= 99) (rule = { ...rule!, interval: v }), write();
    });
    const unit = el("select", { class: "qw-select", "aria-label": "Unit" }, ...(["day", "week", "month", "year"] as const).map((u) => el("option", { value: u }, `${u}${r.interval === 1 ? "" : "s"}`)));
    unit.value = r.freq;
    unit.addEventListener("change", () => {
      rule = { ...blank(unit.value as Rule["freq"]), interval: r.interval, count: r.count, until: r.until };
      if (rule.freq === "week") rule.byDay = [{ n: 0, day: weekday(draft.startDay) }];
      showForm();
      write();
    });
    const rows: HTMLElement[] = [el("div", { class: "chip-rec-row" }, el("span", {}, "Every"), n, unit)];
    if (r.freq === "week") {
      const on = new Set(r.byDay.map((d) => d.day));
      rows.push(
        el(
          "div",
          { class: "chip-rec-days", role: "group", "aria-label": "On" },
          ...DAY_NAMES.map((name, i) =>
            el("button", {
              type: "button",
              "aria-pressed": String(on.has(i)),
              title: name,
              "aria-label": name,
              onclick: () => {
                if (on.has(i) && on.size > 1) on.delete(i);
                else on.add(i);
                rule = { ...rule!, byDay: [...on].sort().map((day) => ({ n: 0, day })) };
                showForm();
                write();
              },
            }, RFC_DAYS[i].slice(0, 2)),
          ),
        ),
      );
    }
    if (r.freq === "month") {
      const date = +draft.startDay.slice(8, 10);
      const d = weekday(draft.startDay);
      const which = Math.min(Math.ceil(date / 7), 4);
      const mode = el("select", { class: "qw-select", "aria-label": "On" }, el("option", { value: "day" }, `On day ${date}`), el("option", { value: "nth" }, `On the ${nth(which)} ${DAY_NAMES[d]}`), el("option", { value: "last" }, `On the last ${DAY_NAMES[d]}`));
      mode.value = r.byDay.length ? (r.byDay[0].n === -1 ? "last" : "nth") : "day";
      mode.addEventListener("change", () => {
        rule = { ...rule!, byMonthDay: mode.value === "day" ? [date] : [], byDay: mode.value === "day" ? [] : [{ n: mode.value === "last" ? -1 : which, day: d }] };
        write();
      });
      rows.push(el("div", { class: "chip-rec-row" }, mode));
    }
    const endsMode = r.until ? "until" : r.count ? "count" : "never";
    const ends = el("select", { class: "qw-select", "aria-label": "Ends" }, el("option", { value: "never" }, "Never ends"), el("option", { value: "until" }, "Ends on"), el("option", { value: "count" }, "Ends after"));
    ends.value = endsMode;
    const until = el("input", { type: "date", class: "chip-date", value: r.until ?? addDays(draft.startDay, 90), "aria-label": "Last day" });
    const count = el("input", { type: "number", class: "chip-n", min: "1", max: "999", value: String(r.count ?? 10), "aria-label": "How many times" });
    ends.addEventListener("change", () => {
      rule = { ...rule!, until: ends.value === "until" ? until.value : undefined, count: ends.value === "count" ? +count.value : undefined };
      showForm();
      write();
    });
    until.addEventListener("change", () => until.value && ((rule = { ...rule!, until: until.value }), write()));
    count.addEventListener("input", () => +count.value >= 1 && ((rule = { ...rule!, count: Math.round(+count.value) }), write()));
    rows.push(el("div", { class: "chip-rec-row" }, ends, endsMode === "until" ? until : endsMode === "count" ? el("span", { class: "cal-inline" }, count, "times") : null));
    return rows;
  };
  if (index < 0 && rule) form.replaceChildren(...ruleForm());
  write();
  return el("div", { class: "cal-field cal-repeat-field" }, el("span", { class: "cal-field-icon", title: "Repeat" }, icon("repeat", 15)), el("div", { class: "cal-stack" }, select, form, summary));
}

// ------------------------------------------------------------------ the editor

/** Open the editor for a draft, by `at`. New events and existing ones look the same; only their buttons differ. */
export function openEditor(at: DOMRect, draft: Draft, env: EditorEnv, isNew: boolean): { close(): void } {
  const d: Draft = structuredClone(draft);
  const ro = env.readOnly;
  const title = el("input", { class: "cal-title", placeholder: "Add title", value: d.title, "aria-label": "Title", readonly: ro });
  const allDay = el("input", { type: "checkbox", checked: d.allDay, disabled: ro, "aria-label": "All day" });
  const startDay = el("input", { type: "date", value: d.startDay, disabled: ro, "aria-label": "Starts on" });
  const startTime = el("input", { type: "time", value: d.startTime, step: "300", disabled: ro, "aria-label": "Starts at" });
  const endDay = el("input", { type: "date", value: d.endDay, disabled: ro, "aria-label": "Ends on" });
  const endTime = el("input", { type: "time", value: d.endTime, step: "300", disabled: ro, "aria-label": "Ends at" });
  const writable = env.calendars.filter((c) => c.writable);
  const calendar = el("select", { class: "qw-select", "aria-label": "Calendar", disabled: ro || !isNew }, ...(isNew ? writable : env.calendars).map((c) => el("option", { value: c.id }, c.title)));
  calendar.value = d.calendar;
  const swatch = el("span", { class: "cal-swatch" });
  const location = el("input", { class: "cal-text", placeholder: "Add location", value: d.location, readonly: ro, "aria-label": "Location" });
  const description = el("textarea", { class: "cal-text", placeholder: "Add description", rows: "2", readonly: ro, "aria-label": "Description" });
  description.value = d.description;
  const error = el("div", { class: "cal-error", role: "alert" });

  const times = el("div", { class: "cal-times" }, el("span", { class: "cal-muted" }, "Starts"), startDay, startTime, el("span", { class: "cal-muted" }, "Ends"), endDay, endTime);
  const sync = () => {
    times.classList.toggle("is-all-day", allDay.checked);
    swatch.style.setProperty("--calendar", env.calendars.find((c) => c.id === calendar.value)?.color ?? "var(--accent)");
  };
  let repeat: HTMLElement;
  const remake = () => {
    const next = repeatControl(d, () => {}, () => handle.place());
    repeat?.replaceWith(next);
    repeat = next;
  };
  allDay.addEventListener("change", () => {
    d.allDay = allDay.checked;
    sync();
    remake();
  });
  startDay.addEventListener("change", () => {
    // Moving the start moves the end with it, keeping the length.
    const shift = Math.round((Date.parse(startDay.value) - Date.parse(d.startDay)) / 86_400_000);
    if (startDay.value && Number.isFinite(shift)) {
      d.startDay = startDay.value;
      d.endDay = addDays(d.endDay, shift);
      endDay.value = d.endDay;
      remake();
    }
  });
  startTime.addEventListener("change", () => {
    const [h0, m0] = d.startTime.split(":").map(Number);
    const [h1, m1] = startTime.value.split(":").map(Number);
    const [h2, m2] = d.endTime.split(":").map(Number);
    if (!startTime.value) return;
    const end = Math.min(24 * 60 - 5, h2 * 60 + m2 + (h1 * 60 + m1 - h0 * 60 - m0));
    d.startTime = startTime.value;
    if (d.startDay === d.endDay && end > h1 * 60 + m1) endTime.value = d.endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  });
  calendar.addEventListener("change", sync);

  const busy = (on: boolean) => box.classList.toggle("is-busy", on);
  const read = (): Draft | string => {
    const next: Draft = { ...d, title: title.value.trim(), allDay: allDay.checked, startDay: startDay.value, startTime: startTime.value, endDay: endDay.value, endTime: endTime.value, calendar: calendar.value, location: location.value.trim(), description: description.value };
    if (!next.startDay || !next.endDay || (!next.allDay && (!next.startTime || !next.endTime))) return "Give it a start and an end";
    const startKey = next.allDay ? next.startDay : `${next.startDay}T${next.startTime}`;
    const endKey = next.allDay ? next.endDay : `${next.endDay}T${next.endTime}`;
    if (endKey < startKey) return "It can't end before it starts";
    return next;
  };
  const save = async () => {
    const next = read();
    if (typeof next === "string") return void (error.textContent = next);
    const scope = env.repeating ? await chooseScope(box.getBoundingClientRect(), "Save") : undefined;
    if (env.repeating && !scope) return;
    busy(true);
    try {
      if (await env.save(next, scope ?? undefined)) handle.close();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      busy(false);
    }
  };
  const remove = async () => {
    if (!env.remove) return;
    const scope = env.repeating ? await chooseScope(box.getBoundingClientRect(), "Delete") : undefined;
    if (env.repeating && !scope) return;
    busy(true);
    try {
      if (await env.remove(scope ?? undefined)) handle.close();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      busy(false);
    }
  };
  const field = (name: string, label: string, ...children: HTMLElement[]) => el("div", { class: "cal-field" }, el("span", { class: "cal-field-icon", title: label }, icon(name, 15)), ...children);
  const foot = el(
    "div",
    { class: "qw-config-foot cal-foot" },
    !isNew && env.remove && !ro ? el("button", { type: "button", class: "qw-btn", title: "Delete", onclick: () => void remove() }, icon("trash", 15)) : null,
    env.link ? el("a", { class: "qw-btn cal-link", href: env.link, target: "_blank", rel: "noopener noreferrer", title: "Open in Google Calendar" }, icon("open", 15)) : null,
    el("span", { class: "spacer" }),
    ro ? el("span", { class: "cal-ro" }, "This calendar can't be changed here") : el("button", { type: "button", class: "qw-btn primary", onclick: () => void save() }, isNew ? "Add" : "Save"),
  );
  repeat = el("div");
  const handle = popover(
    "cal-editor",
    at,
    env.onClose,
    title,
    el("label", { class: "cal-allday-toggle" }, allDay, "All day"),
    times,
    repeat,
    field("layers", "Calendar", swatch, calendar),
    field("pin", "Location", location),
    field("note", "Description", description),
    ...(env.extra ? [env.extra] : []),
    error,
    foot,
  );
  const box = handle.box;
  remake();
  sync();
  handle.place();
  box.addEventListener("keydown", (e) => {
    if (ro) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target === title)) {
      e.preventDefault();
      void save();
    }
  });
  (ro ? box : title).focus();
  if (!ro && isNew) title.select();
  return handle;
}
