// Pomodoro, from the app's catalog. It runs sandboxed: its clock runs in its extension host (which
// lives as long as the page, so it keeps going when its note closes), each embed is a webview it
// talks to by messages, and its state (state.json) keeps it across reloads.
const PHASES = { work: "Work", break: "Break", long: "Long break" };

function duration(text, fallback) {
  if (!text) return fallback;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 60000;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || !(m[1] || m[2] || m[3])) return fallback;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
}

function format(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const PAGE = `
<style>
  body { font: 0.9rem/1.4 var(--prose); }
  .box { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .phase { color: var(--muted); min-width: 6.5rem; }
  .time { font: 1.6rem var(--mono); font-variant-numeric: tabular-nums; min-width: 5ch; }
  .running .time { color: var(--accent); }
  button { font: inherit; color: var(--ink); background: none; border: 1px solid var(--line); border-radius: 4px; padding: 0.1rem 0.6rem; cursor: pointer; }
  .round { color: var(--muted); font-size: 0.8rem; }
</style>
<div class="box" id="box">
  <span class="phase" id="phase">Work</span>
  <span class="time" id="time">25:00</span>
  <button id="go">Start</button><button id="skip">Skip</button><button id="reset">Reset</button>
  <span class="round" id="round"></span>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  commonInk.onMessage((m) => {
    $("phase").textContent = m.label ? m.phase + " · " + m.label : m.phase;
    $("time").textContent = m.time;
    $("go").textContent = m.running ? "Pause" : "Start";
    $("round").textContent = "Round " + m.round + " of " + m.rounds;
    $("box").classList.toggle("running", m.running);
  });
  for (const id of ["go", "skip", "reset"]) $(id).addEventListener("click", () => commonInk.post({ do: id }));
  commonInk.post({ do: "hello" });
</script>`;

export default {
  async activate(ctx) {
    const kept = (await ctx.state.get()) || {};
    const sessions = kept.sessions || {};
    const views = new Map();
    const updates = new WeakMap();
    const save = () => ctx.state.set({ sessions }).catch(() => {});

    const config = (embed) => ({
      work: duration(embed.args.work, 25 * 60000),
      break: duration(embed.args.break, 5 * 60000),
      long: duration(embed.args.long, 15 * 60000),
      rounds: Math.max(1, Number(embed.args.rounds) || 4),
      label: embed.args.label || "",
    });
    const fresh = (c) => ({ ...c, phase: "work", round: 1, running: false, since: 0, elapsed: 0 });
    const left = (s, now) => Math.max(0, s[s.phase] - s.elapsed - (s.running ? now - s.since : 0));
    const next = (s) => {
      if (s.phase === "work") return { ...s, phase: s.round % s.rounds === 0 ? "long" : "break", elapsed: 0, since: Date.now() };
      return { ...s, phase: "work", round: s.round + 1, elapsed: 0, since: Date.now() };
    };
    const show = (key) => {
      const s = sessions[key];
      if (!s) return;
      const message = { phase: PHASES[s.phase], label: s.label, time: format(left(s, Date.now())), running: s.running, round: ((s.round - 1) % s.rounds) + 1, rounds: s.rounds };
      for (const view of views.get(key) || []) view.post(message);
    };
    const status = () => {
      const running = Object.values(sessions).find((s) => s.running);
      ctx.statusBar.set("pomodoro.phase", running ? `🍅 ${PHASES[running.phase]} ${format(left(running, Date.now()))}` : "");
    };

    /** A session takes its block's arguments, keeping where it is in its rounds. */
    const take = (embed) => {
      const c = config(embed);
      const was = sessions[embed.key];
      sessions[embed.key] = was ? { ...was, work: c.work, break: c.break, long: c.long, rounds: c.rounds, label: c.label } : fresh(c);
      return c;
    };

    ctx.embeds.register("pomodoro", {
      resolve(webview, embed) {
        let c = take(embed);
        views.set(embed.key, [...(views.get(embed.key) || []), webview]);
        webview.onMessage((m) => {
          const s = sessions[embed.key];
          const now = Date.now();
          if (m.do === "go") sessions[embed.key] = s.running ? { ...s, running: false, elapsed: s.elapsed + now - s.since } : { ...s, running: true, since: now };
          if (m.do === "skip") sessions[embed.key] = { ...next(s), running: s.running };
          if (m.do === "reset") sessions[embed.key] = fresh(c);
          if (m.do !== "hello") save();
          show(embed.key);
          status();
        });
        webview.html = PAGE;
        updates.set(webview, (next) => {
          c = take(next);
          show(next.key);
          save();
        });
      },
      // New arguments (a longer break, a label) go to the running page: it isn't drawn again.
      update(webview, embed) {
        updates.get(webview)?.(embed);
      },
    });

    setInterval(() => {
      const now = Date.now();
      for (const [key, s] of Object.entries(sessions)) {
        if (s.running && left(s, now) === 0) {
          sessions[key] = { ...next(s), running: true };
          const n = sessions[key];
          ctx.notifications.show(n.phase === "work" ? "Back to work" : "Time for a break", `${PHASES[n.phase]}: ${format(n[n.phase])}${n.label ? ` · ${n.label}` : ""}`).catch(() => {});
          save();
        }
        show(key);
      }
      status();
    }, 1000);
  },
};
