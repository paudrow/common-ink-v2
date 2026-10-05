// Timers and stopwatches as data: what's elapsed is what had elapsed when it last paused, plus the time
// since it last started, if it's running. That's all that's kept, so a timer keeps time across reloads.

export interface Clock {
  kind: "timer" | "stopwatch";
  label: string;
  /** A timer's length, in ms; 0 for a stopwatch. */
  duration: number;
  running: boolean;
  /** When it last started, while it's running (epoch ms). */
  since: number;
  /** What had elapsed when it last paused, in ms. */
  elapsed: number;
  /** A timer that reached zero. */
  done: boolean;
  /** The note it's in. */
  note: string | null;
}

export interface Alarm {
  at: string;
  label: string;
  on: boolean;
  /** The day it last rang (YYYY-MM-DD), so it rings once a day. */
  rang: string | null;
  note: string | null;
}

/** A duration (90s, 25m, 1h30m, or a number of minutes) in ms, or null if it isn't one. */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 60_000;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

export const elapsedAt = (c: Clock, now: number) => c.elapsed + (c.running ? now - c.since : 0);

export const remainingAt = (c: Clock, now: number) => Math.max(0, c.duration - elapsedAt(c, now));

export const start = (c: Clock, now: number): Clock => (c.running ? c : { ...c, running: true, since: now, done: false, elapsed: c.done ? 0 : c.elapsed });

export const pause = (c: Clock, now: number): Clock => (c.running ? { ...c, running: false, elapsed: elapsedAt(c, now) } : c);

export const reset = (c: Clock): Clock => ({ ...c, running: false, elapsed: 0, done: false });

/** A timer that has run out by `now`, stopped at zero. Others as they are. */
export const settle = (c: Clock, now: number): Clock => (c.kind === "timer" && c.running && remainingAt(c, now) === 0 ? { ...c, running: false, elapsed: c.duration, done: true } : c);

/** 4:05, 25:00, 1:02:03. */
export function format(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "07:30" as hours and minutes, or null if it isn't a time of day. */
export function timeOfDay(at: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whether an alarm that's on should ring now: it's past its time today, and it hasn't rung today. */
export function due(alarm: Alarm, now: Date): boolean {
  const t = timeOfDay(alarm.at);
  if (!alarm.on || !t || alarm.rang === day(now)) return false;
  return now.getHours() * 60 + now.getMinutes() >= t.h * 60 + t.m;
}

/** The alarm, rung today. */
export const rung = (alarm: Alarm, now: Date): Alarm => ({ ...alarm, rang: day(now) });

/** An alarm switched on: if its time has passed today, it waits for tomorrow. */
export const switchOn = (alarm: Alarm, now: Date): Alarm => {
  const t = timeOfDay(alarm.at);
  const passed = !!t && now.getHours() * 60 + now.getMinutes() >= t.h * 60 + t.m;
  return { ...alarm, on: true, rang: passed ? day(now) : null };
};
