// What every Calendar view draws from, and how the page asks things of them. The page (page.ts) owns
// the events, the focus and the editor; a view draws a stretch of days and reports what you do in it.
import type { Occurrence } from "common-ink/calendar";
import { addDays, dayOf, daysBetween, type Day, type View } from "./model.ts";

/** Where an event goes when it's dragged: new days, and for one with times, new minutes from midnight. */
export type Moved = { allDay: true; startDay: Day; endDay: Day } | { allDay: false; startDay: Day; start: number; endDay: Day; end: number };

/** A new event's place, from a click or a drag: a day (all day) or a day and minutes. */
export type Slot = { allDay: true; startDay: Day; endDay: Day } | { allDay: false; day: Day; start: number; end: number };

export interface ViewEnv {
  weekStart: number;
  startHour: number;
  today(): Day;
  /** The events between two days (the second not included), or null while they load (the view is drawn again when they're in). */
  events(from: Day, to: Day): Occurrence[] | null;
  color(o: Occurrence): string;
  writable(o: Occurrence): boolean;
  /** The event the keyboard is on, by address. */
  focused(): string | null;
  open(o: Occurrence, at: DOMRect): void;
  create(slot: Slot, at: DOMRect, ghost?: HTMLElement): void;
  move(o: Occurrence, to: Moved, at: DOMRect): void;
  /** The view scrolled: its first day on screen is now this. */
  scrolled(anchor: Day): void;
  /** Show another view at a day (a click on a day in a month or a year). */
  show(view: View, day: Day): void;
}

export interface CalendarView {
  root: HTMLElement;
  /** Bring a day's period on screen; `smooth` glides there unless motion is reduced. */
  goto(day: Day, smooth: boolean): void;
  /** Draw again: events changed, or the focus moved. */
  redraw(): void;
  /** The events on screen, in order, for j and k. */
  visible(): Occurrence[];
  /** Bring an event on screen, if it's drawn. */
  reveal(address: string): void;
  destroy(): void;
}

/** An event's local days and times. A timed event's end day is the day it ends on (so 23:00–01:00 spans two). */
export function localSpan(o: Occurrence): { startDay: Day; endDay: Day; start: number; end: number } {
  if (o.allDay) return { startDay: o.start, endDay: o.end, start: 0, end: 0 };
  const s = new Date(o.start);
  const e = new Date(o.end);
  return { startDay: dayOf(s), endDay: dayOf(e), start: s.getHours() * 60 + s.getMinutes(), end: e.getHours() * 60 + e.getMinutes() };
}

/**
 * Where a timed event goes when it's dropped: dragged from one day to another and a new start, or its
 * end dragged to a time. `start` and `end` are minutes from midnight on the day it's dropped on.
 */
export function dropped(o: Occurrence, d: { kind: "move" | "resize"; startDay: Day; day: Day; start: number; end: number }): Moved {
  const s = localSpan(o);
  const shift = daysBetween(d.startDay, d.day);
  const startDay = addDays(s.startDay, shift);
  if (d.kind === "resize") return { allDay: false, startDay, start: s.startDay === d.startDay ? s.start : 0, endDay: d.day, end: d.end };
  // An event that runs past midnight keeps its end day; one within a day ends on its new day.
  if (s.startDay !== s.endDay) return { allDay: false, startDay, start: d.start, endDay: addDays(s.endDay, shift), end: s.end };
  return { allDay: false, startDay, start: d.start, endDay: startDay, end: d.end };
}

/** An event long enough to sit with the all-day ones: all day, or 24 hours or more. */
export const longEvent = (o: Occurrence) => o.allDay || Date.parse(o.end) - Date.parse(o.start) >= 86_400_000;

/** "9:30", "9:30 AM": a time of day as the person's locale writes it. */
export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
