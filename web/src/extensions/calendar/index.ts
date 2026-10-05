// Calendar, a built-in extension on the data source API (ADR 0007): the coming days' events in the
// side panel, kept up to date as records change, and a command to connect Google.
import type { Occurrence } from "../../../../worker/src/calendar.ts";
import type { SourceState } from "../../../../worker/src/data-sources.ts";
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** What to show when a source can't answer: the reason, and a way to connect when that's what's missing. */
async function trouble(ctx: ExtensionContext, root: HTMLElement, err: unknown) {
  const status = await ctx.data.status().catch(() => null);
  const message = el("p", { className: "message", textContent: (err as Error).message });
  const connect =
    status?.using === "none" && status.googleAvailable ? el("button", { className: "connect", textContent: "Connect Google calendar and contacts", onclick: () => ctx.data.connect() }) : "";
  root.replaceChildren(message, connect);
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Today", "Tomorrow", or "Thursday 8 October". */
function dayName(day: string, today: string, tomorrow: string): string {
  if (day === today) return "Today";
  if (day === tomorrow) return "Tomorrow";
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/** "Reconnect Google Calendar", above the events, while Google needs you to sign in again. */
function reconnect(ctx: ExtensionContext, state: SourceState | undefined): HTMLElement | "" {
  if (state?.state !== "needs-reconnect") return "";
  const waiting = state.pending ? ` ${state.pending === 1 ? "One edit is" : `${state.pending} edits are`} waiting to go to Google.` : "";
  return el(
    "div",
    { className: "reconnect", role: "alert" },
    el("p", { textContent: `Google ended Common Ink's access to your calendar.${waiting}` }),
    el("button", { className: "connect", textContent: "Reconnect Google Calendar", onclick: () => ctx.data.connect() }),
  );
}

const calendar: ExtensionModule = {
  activate(ctx) {
    // Showing the calendar brings Google's changes in, at most twice a minute; they draw as they arrive.
    let synced = 0;
    const sync = () => {
      if (Date.now() - synced < 30_000) return;
      synced = Date.now();
      void ctx.data.sync().catch(() => {});
    };
    ctx.views.register("calendar", {
      async render(root) {
        sync();
        const DAYS = ctx.settings.get<number>("calendar.days");
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + DAYS * 86_400_000);
        let events: Occurrence[];
        let colors: Map<string, string>;
        try {
          [events, colors] = await Promise.all([ctx.data.calendar.events(start, end), ctx.data.calendar.calendars().then((cs) => new Map(cs.map((c) => [c.id, c.color])))]);
        } catch (err) {
          return trouble(ctx, root, err);
        }
        const today = localDay(start);
        const tomorrow = localDay(new Date(start.getTime() + 86_400_000));
        const days = new Map<string, Occurrence[]>();
        for (const e of events) {
          // An all-day event's day is its date; a timed one's is its local start day, before today's counted as today.
          const day = e.allDay ? e.start : localDay(new Date(e.start));
          const key = day < today ? today : day;
          days.set(key, [...(days.get(key) ?? []), e]);
        }
        const status = await ctx.data.status();
        const note = status.using === "fixtures" ? el("p", { className: "message", textContent: "The Sample calendar: this Preview has no Google account." }) : "";
        const banner = reconnect(ctx, status.sources.find((s) => s.source === "google"));
        if (!events.length) return root.replaceChildren(banner, note, el("p", { className: "empty", textContent: `Nothing in the next ${DAYS} days.` }));
        root.replaceChildren(
          banner,
          note,
          ...[...days].map(([day, list]) =>
            el(
              "section",
              {},
              el("h3", { textContent: dayName(day, today, tomorrow) }),
              el(
                "ul",
                {},
                ...list.map((e) =>
                  el(
                    "li",
                    { className: "event", title: e.address, style: `--calendar: ${colors.get(e.calendar) ?? "var(--accent)"}` },
                    el("span", { className: "when", textContent: e.allDay ? "All day" : `${time(e.start)}–${time(e.end)}` }),
                    el("span", { className: "what", textContent: `${e.title}${e.series ? " ↻" : ""}`, title: e.series ? "Repeats" : "" }),
                    e.location ? el("span", { className: "where", textContent: e.location }) : "",
                  ),
                ),
              ),
            ),
          ),
        );
      },
    });
    ctx.data.calendar.onChange(() => ctx.views.refresh("calendar"));
    ctx.commands.register("calendar.show", () => ctx.views.toggle("calendar"));
    ctx.commands.register("google.connect", () => ctx.data.connect());
  },
};

export default calendar;
