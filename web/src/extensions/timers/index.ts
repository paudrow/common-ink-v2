// Timers, a built-in extension: `::timer`, `::stopwatch` and `::alarm` embeds (clock.ts), drawn in
// the note. New arguments (a new duration, say) apply in place, keeping the time it's at. Their state is the extension's (state.json, in history), keyed by each embed's key, so they
// keep going when their note closes or the page reloads. While one runs, the status bar shows it;
// when one is done, it rings (Web Audio, made here) and notifies.
import { EditorView } from "@codemirror/view";
import type { Embed, ExtensionContext } from "../../extension-api.ts";
import { due, elapsedAt, format, parseDuration, pause, remainingAt, reset, rung, settle, start, switchOn, timeOfDay, type Alarm, type Clock } from "./clock.ts";

interface State {
  clocks: Record<string, Clock>;
  alarms: Record<string, Alarm>;
}

const DEFAULT_DURATION = 25 * 60_000;

function stateOf(value: unknown): State {
  const v = (value && typeof value === "object" ? value : {}) as Partial<State>;
  return { clocks: { ...(v.clocks ?? {}) }, alarms: { ...(v.alarms ?? {}) } };
}

let audio: AudioContext | null = null;

/** Three short beeps. The page only plays sound after you've pressed something, so the first press starts the audio. */
function ring() {
  audio ??= new AudioContext();
  const t0 = audio.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const at = t0 + i * 0.4;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    tone.connect(gain).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.32);
  }
}

const button = (text: string, onClick: () => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
};

const span = (className: string) => {
  const s = document.createElement("span");
  s.className = className;
  return s;
};

const theme = EditorView.theme({
  ".timer-embed": { display: "flex", alignItems: "center", gap: "0.75em", padding: "0.4em 0.75em", border: "1px solid var(--line)", borderRadius: "6px", fontFamily: "var(--prose)" },
  ".timer-embed .timer-label": { color: "var(--muted)", fontSize: "0.9em" },
  ".timer-embed .timer-time": { fontFamily: "var(--mono)", fontSize: "1.4em", fontVariantNumeric: "tabular-nums", minWidth: "4.5ch" },
  ".timer-embed.running .timer-time": { color: "var(--accent)" },
  ".timer-embed.done .timer-time": { color: "#c2410c" },
  ".timer-embed button": { font: "inherit", fontSize: "0.85em", color: "var(--ink)", background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "0.1em 0.6em", cursor: "pointer" },
  ".timer-embed button[aria-pressed=true]": { backgroundColor: "var(--accent-soft)" },
  ".timer-embed .timer-note": { color: "var(--muted)", fontSize: "0.8em", marginLeft: "auto" },
});

export default {
  async activate(ctx: ExtensionContext) {
    const state = stateOf(await ctx.state.get());
    const now = () => Date.now();
    const save = () => void ctx.state.set(state).catch(() => {});
    // Timers that ran out while the app was closed are done, quietly.
    for (const [key, c] of Object.entries(state.clocks)) state.clocks[key] = settle(c, now());

    /** What's drawn now, to keep up to date; ones no longer on the page drop out. */
    const live = new Set<{ el: HTMLElement; update(): void }>();
    /** The embed each drawn box shows, by the element it was drawn into: new arguments replace it. */
    const drawn = new WeakMap<HTMLElement, { embed: Embed; update(): void }>();
    const takeNew = (el: HTMLElement, embed: Embed) => {
      const d = drawn.get(el);
      if (!d) return;
      d.embed = embed;
      d.update();
    };

    const clockFor = (embed: Embed, kind: Clock["kind"]): Clock => {
      const duration = kind === "timer" ? (parseDuration(embed.args.duration) ?? DEFAULT_DURATION) : 0;
      const label = embed.args.label ?? "";
      const c = state.clocks[embed.key];
      if (!c) return { kind, label, duration, running: false, since: 0, elapsed: 0, done: false, note: embed.note };
      // Its block changed (a new duration or label): it takes them, keeping its time.
      return c.duration === duration && c.label === label && c.note === embed.note ? c : { ...c, kind, duration, label, note: embed.note };
    };

    const alarmFor = (embed: Embed): Alarm => {
      const at = embed.args.at ?? "07:30";
      const label = embed.args.label ?? "";
      const a = state.alarms[embed.key];
      if (!a) return { at, label, on: false, rang: null, note: embed.note };
      return a.at === at && a.label === label && a.note === embed.note ? a : { ...a, at, label, note: embed.note };
    };

    const changed = () => {
      save();
      refresh();
    };

    const drawClock = (el: HTMLElement, first: Embed, kind: Clock["kind"]) => {
      const box = document.createElement("div");
      box.className = "timer-embed";
      const label = span("timer-label");
      const time = span("timer-time");
      const ref = { embed: first, update: () => {} };
      const toggle = button("Start", () => {
        audio ??= new AudioContext();
        const c = clockFor(ref.embed, kind);
        state.clocks[ref.embed.key] = c.running ? pause(c, now()) : start(c, now());
        changed();
      });
      const again = button("Reset", () => {
        state.clocks[ref.embed.key] = reset(clockFor(ref.embed, kind));
        changed();
      });
      box.append(label, time, toggle, again);
      const update = () => {
        const c = clockFor(ref.embed, kind);
        const t = now();
        label.textContent = c.label || (kind === "timer" ? "Timer" : "Stopwatch");
        time.textContent = format(kind === "timer" ? remainingAt(c, t) : elapsedAt(c, t));
        toggle.textContent = c.running ? "Pause" : c.done ? "Again" : c.elapsed ? "Resume" : "Start";
        box.classList.toggle("running", c.running);
        box.classList.toggle("done", c.done);
      };
      ref.update = update;
      el.replaceChildren(box);
      live.add({ el: box, update });
      drawn.set(el, ref);
      update();
    };

    const drawAlarm = (el: HTMLElement, first: Embed) => {
      const box = document.createElement("div");
      box.className = "timer-embed";
      const label = span("timer-label");
      const time = span("timer-time");
      const note = span("timer-note");
      const ref = { embed: first, update: () => {} };
      const toggle = button("Off", () => {
        audio ??= new AudioContext();
        const a = alarmFor(ref.embed);
        state.alarms[ref.embed.key] = a.on ? { ...a, on: false } : switchOn(a, new Date());
        changed();
      });
      box.append(label, time, toggle, note);
      const update = () => {
        const a = alarmFor(ref.embed);
        label.textContent = a.label || "Alarm";
        time.textContent = a.at;
        toggle.textContent = a.on ? "On" : "Off";
        toggle.setAttribute("aria-pressed", String(a.on));
        note.textContent = !timeOfDay(a.at) ? `"${a.at}" isn't a time of day, like 07:30` : a.on ? "Rings while Common Ink is open" : "";
        box.classList.toggle("running", a.on);
      };
      ref.update = update;
      el.replaceChildren(box);
      live.add({ el: box, update });
      drawn.set(el, ref);
      update();
    };

    ctx.editor.extend(theme);
    ctx.embeds.register("timer", { render: (el, embed) => drawClock(el, embed, "timer"), update: takeNew });
    ctx.embeds.register("stopwatch", { render: (el, embed) => drawClock(el, embed, "stopwatch"), update: takeNew });
    ctx.embeds.register("alarm", { render: drawAlarm, update: takeNew });

    /** The status bar: the running timer nearest its end (and how many more run), or else the next alarm. */
    const status = () => {
      const t = now();
      const running = Object.values(state.clocks).filter((c) => c.running);
      running.sort((a, b) => (a.kind === "timer" ? remainingAt(a, t) : Infinity) - (b.kind === "timer" ? remainingAt(b, t) : Infinity));
      const first = running[0];
      if (first) {
        const more = running.length > 1 ? ` +${running.length - 1}` : "";
        const shown = first.kind === "timer" ? remainingAt(first, t) : elapsedAt(first, t);
        return ctx.statusBar.set("timers.running", `⏱ ${first.label || (first.kind === "timer" ? "Timer" : "Stopwatch")} ${format(shown)}${more}`, "Go to the running timer");
      }
      const alarm = Object.values(state.alarms).find((a) => a.on);
      ctx.statusBar.set("timers.running", alarm ? `⏰ ${alarm.label ? `${alarm.label} ` : ""}${alarm.at}` : "", alarm ? "An alarm is on" : undefined);
    };

    const refresh = () => {
      for (const item of live) {
        if (item.el.isConnected) item.update();
        else live.delete(item);
      }
      status();
    };

    const tick = () => {
      const t = now();
      let rang = false;
      for (const [key, c] of Object.entries(state.clocks)) {
        const settled = settle(c, t);
        if (settled === c) continue;
        state.clocks[key] = settled;
        rang = true;
        void ctx.notifications.show(`${c.label || "Timer"} is done`, `${format(c.duration)} is up.`).catch(() => {});
      }
      for (const [key, a] of Object.entries(state.alarms)) {
        if (!due(a, new Date(t))) continue;
        state.alarms[key] = rung(a, new Date(t));
        rang = true;
        void ctx.notifications.show(a.label || "Alarm", `It's ${a.at}.`).catch(() => {});
      }
      if (rang) {
        ring();
        save();
      }
      refresh();
    };
    window.setInterval(tick, 250);
    tick();

    ctx.commands.register("timers.openRunning", () => {
      const c = Object.values(state.clocks).find((x) => x.running) ?? Object.values(state.alarms).find((a) => a.on);
      if (c?.note) void ctx.workbench.open(c.note as Parameters<typeof ctx.workbench.open>[0]);
    });
    ctx.commands.register("timers.stopAll", () => {
      for (const [key, c] of Object.entries(state.clocks)) state.clocks[key] = pause(c, now());
      for (const [key, a] of Object.entries(state.alarms)) state.alarms[key] = { ...a, on: false };
      changed();
    });
  },
};
