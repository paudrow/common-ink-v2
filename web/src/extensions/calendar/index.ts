// Calendar, a built-in extension on the data source API (ADR 0007): the coming days' events in the
// side panel, kept up to date as records change, and a command to connect Google.
import type { Occurrence } from "../../../../worker/src/calendar.ts";
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

const calendar: ExtensionModule = {
  activate(ctx) {
    ctx.views.register("calendar", {
      async render(root) {
        const DAYS = ctx.settings.get<number>("calendar.days");
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + DAYS * 86_400_000);
        let events: Occurrence[];
        try {
          events = await ctx.data.calendar.events(start, end);
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
        if (!events.length) return root.replaceChildren(note, el("p", { className: "empty", textContent: `Nothing in the next ${DAYS} days.` }));
        root.replaceChildren(
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
                    { className: "event", title: e.address },
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
