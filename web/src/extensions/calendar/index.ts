// Calendar, a built-in extension on the data source API (ADR 0007). In a tab it's the whole calendar
// (page.ts, loaded when it's first shown); in the side panel, the coming days' events. In notes, links
// to events are chips (links.ts), so it starts with the app. Everything keeps up as records change.
import type { Occurrence } from "../../../../worker/src/calendar.ts";
import type { SourceState } from "../../../../worker/src/data-sources.ts";
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import type { EventFound } from "../../../../worker/src/operations.ts";
import { EventLinks, dayOfEvent, linkTo } from "./links.ts";
import { notesSection } from "./notes.ts";
import type { CalendarPage, PageState } from "./page.ts";

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
    const pages = new Set<CalendarPage>();
    /** An event a chip's click asked the next Calendar tab to show. */
    let reveal: { address: string; day: string } | undefined;
    ctx.views.register("calendar", {
      async render(root) {
        sync();
        if (!root.closest("#panel")) {
          // In a tab: the whole calendar. One page per tab, kept until the tab draws something else.
          for (const p of pages) if (!document.contains(p.root)) (p.destroy(), pages.delete(p));
          const { CalendarPage } = await import("./page.ts");
          const page = new CalendarPage(ctx, ((await ctx.state.get()) ?? {}) as PageState, reveal);
          reveal = undefined;
          page.extra = async (o, found) => notesSection(ctx, o, found, found ? dayOfEvent(found) : o.start.slice(0, 10));
          pages.add(page);
          root.replaceChildren(page.root);
          page.root.focus({ preventScroll: true });
          return;
        }
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
    // Links to events in notes are chips; a click shows the event in a Calendar tab, open on it.
    const links = new EventLinks(ctx, (address, found: EventFound | null) => {
      reveal = { address, day: found ? dayOfEvent(found) : new Date().toISOString().slice(0, 10) };
      ctx.views.open("calendar", { newTab: true });
    });
    ctx.editor.extend(links.extension());
    // ⌘⇧P, Insert event link…: pick an event from the coming weeks (or the last one) for the note you're in.
    ctx.commandBar.provide({
      prefix: "event:",
      placeholder: "Link an event: type part of its name",
      async items(query) {
        const editor = target;
        const from = new Date(Date.now() - 7 * 86_400_000);
        const events = await ctx.data.calendar.events(from, new Date(Date.now() + 30 * 86_400_000)).catch(() => [] as Occurrence[]);
        const unique = [...new Map(events.map((o) => [o.address, o])).values()];
        return ctx.util.fuzzyFilter(query, unique, (o) => o.title).map((o) => ({
          label: o.title || "(No title)",
          detail: o.allDay ? o.start : new Date(o.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
          run: () => {
            if (!editor) return ctx.workbench.notice("Open a note to link an event in it");
            const at = editor.state.selection.main;
            editor.dispatch({ changes: { from: at.from, to: at.to, insert: linkTo(o) }, selection: { anchor: at.from + linkTo(o).length } });
            editor.focus();
          },
        }));
      },
    });
    let target: ReturnType<ExtensionContext["editor"]["focused"]> = null;
    ctx.commands.register("calendar.insertLink", () => {
      target = ctx.editor.focused();
      ctx.commandBar.open("event:");
    });
    ctx.data.calendar.onChange(() => {
      links.refresh();
      for (const p of pages) p.refresh();
      // The side panel draws again; a tab's page loads what changed without drawing from nothing.
      if (ctx.views.shown() === "calendar") ctx.views.show("calendar");
    });
    ctx.commands.register("calendar.open", () => ctx.views.open("calendar", { newTab: true }));
    ctx.commands.register("calendar.show", () => ctx.views.toggle("calendar"));
    ctx.commands.register("google.connect", () => ctx.data.connect());
  },
};

export default calendar;
