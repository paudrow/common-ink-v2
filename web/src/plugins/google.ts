// Calendar and contacts, built-in plugins on the data source API: each is a panel (and so also opens
// in a window), with a command to show it and one to connect Google.
import type { Event } from "../../../worker/src/sources.ts";
import type { PluginContext, PluginModule } from "../plugins.ts";

const DAYS = 14;

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** What to show when a source can't answer: the reason, and a way to connect when that's what's missing. */
async function trouble(ctx: PluginContext, root: HTMLElement, err: unknown) {
  const status = await ctx.sources.status().catch(() => null);
  const message = el("p", { className: "message", textContent: (err as Error).message });
  const connect =
    status?.using === "none" && status.googleAvailable ? el("button", { className: "connect", textContent: "Connect Google calendar and contacts", onclick: () => ctx.sources.connect() }) : "";
  root.replaceChildren(message, connect);
}

const dayKey = (e: Event) => e.start.slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Today", "Tomorrow", or "Thursday 8 October". */
function dayName(day: string, today: string, tomorrow: string): string {
  if (day === today) return "Today";
  if (day === tomorrow) return "Tomorrow";
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const calendarPlugin: PluginModule = {
  activate(ctx) {
    ctx.panels.register({
      id: "calendar",
      title: "Calendar",
      async render(root) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + DAYS * 86_400_000);
        let events: Event[];
        try {
          events = await ctx.sources.events(start, end);
        } catch (err) {
          return trouble(ctx, root, err);
        }
        const today = localDay(start);
        const tomorrow = localDay(new Date(start.getTime() + 86_400_000));
        const days = new Map<string, Event[]>();
        for (const e of events) {
          // An all-day event's day is its date; a timed one's is its local start day.
          const day = e.allDay ? dayKey(e) : localDay(new Date(e.start));
          days.set(day, [...(days.get(day) ?? []), e]);
        }
        const status = await ctx.sources.status();
        const note = status.using === "fixtures" ? el("p", { className: "message", textContent: "Sample events: this Preview has no Google account." }) : "";
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
                    { className: "event" },
                    el("span", { className: "when", textContent: e.allDay ? "All day" : `${time(e.start)}–${time(e.end)}` }),
                    el("span", { className: "what", textContent: `${e.title}${e.recurring ? " ↻" : ""}`, title: e.recurring ? "Repeats" : "" }),
                    e.location ? el("span", { className: "where", textContent: e.location }) : "",
                  ),
                ),
              ),
            ),
          ),
        );
      },
    });
    ctx.commands.register(
      { id: "calendar.show", title: "Show calendar", run: () => ctx.panels.toggle("calendar") },
      { id: "google.connect", title: "Connect Google calendar and contacts", run: () => ctx.sources.connect() },
    );
  },
};

export const contactsPlugin: PluginModule = {
  activate(ctx) {
    let query = "";
    ctx.panels.register({
      id: "contacts",
      title: "Contacts",
      async render(root) {
        const search = el<HTMLInputElement>("input", { type: "search", placeholder: "Search contacts", value: query, className: "search" });
        const list = el("ul", {});
        const fill = async () => {
          try {
            const contacts = await ctx.sources.contacts(query);
            list.replaceChildren(
              ...contacts.map((c) =>
                el(
                  "li",
                  { className: "contact" },
                  el("span", { className: "what", textContent: c.name }),
                  c.organization ? el("span", { className: "where", textContent: c.organization }) : "",
                  ...c.emails.map((e) => el("a", { href: `mailto:${e}`, textContent: e })),
                  ...c.phones.map((p) => el("a", { href: `tel:${p.replace(/[^\d+]/g, "")}`, textContent: p })),
                ),
              ),
              ...(contacts.length ? [] : [el("li", { className: "empty", textContent: query ? "No one matches." : "No contacts." })]),
            );
          } catch (err) {
            await trouble(ctx, root, err);
          }
        };
        search.addEventListener("input", () => {
          query = search.value;
          void fill();
        });
        root.replaceChildren(search, list);
        await fill();
      },
    });
    ctx.commands.register({ id: "contacts.show", title: "Show contacts", run: () => ctx.panels.toggle("contacts") });
  },
};
