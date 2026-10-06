// Notes and events (ADR 0007): a markdown link to an event, `[Team sync](event:google/primary/abc)`,
// draws in live preview as a chip with the event's day, time and title as they are now, kept up to date
// as the event changes. The link's own text is what it said when it was made, for anywhere markdown is
// read. A click on the chip shows the event in the calendar; with the cursor on it, it's the link again.
import type { Occurrence } from "common-ink/calendar";
import { instantOf } from "common-ink/calendar";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { livePreview, type Preview } from "common-ink/live-preview";
import type { EventFound } from "../../../../worker/src/operations.ts";
import type { ExtensionContext } from "../../extension-api.ts";
import { dayOf } from "./model.ts";

/** A link to an event: its text and its address. */
export const EVENT_LINK = /\[([^\]\n]*)\]\((event:[a-z]+\/[^)\s/]+\/[^)\s/]+)\)/g;

/** What a chip says about its event, once it's known: or that there's no such event. */
type Known = { found: EventFound } | { missing: true };

/** "Mon, Oct 5 · 9:00 AM", in the person's time zone; a day alone for an all-day event. */
export function whenLabel(found: EventFound): string {
  const e = found.event;
  if (e.allDay) return new Date(`${e.start}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const at = new Date(instantOf(e.start, e.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  return `${at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The local day an event starts on, for showing it in the calendar. */
export function dayOfEvent(found: EventFound): string {
  const e = found.event;
  if (e.allDay) return e.start;
  return dayOf(new Date(instantOf(e.start, e.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)));
}

/** The same for an occurrence as the calendar drew it, when its event can't be read. */
export const dayOfOccurrence = (o: Pick<Occurrence, "allDay" | "start">): string => (o.allDay ? o.start : dayOf(new Date(o.start)));

export class EventLinks {
  private known = new Map<string, Known>();
  private asking = new Set<string>();
  /** Calendars' colours, for each chip's dot, asked for once. */
  private colors: Promise<Map<string, string>> | null = null;

  constructor(
    private ctx: ExtensionContext,
    /** Show an event in the calendar, as a click on its chip asks. */
    private show: (address: string, found: EventFound | null) => void,
  ) {}

  /** The editor extension: chips for event links, and their clicks. */
  extension() {
    const chips = this;
    class Chip extends WidgetType {
      constructor(
        readonly address: string,
        readonly text: string,
      ) {
        super();
      }

      eq(other: Chip) {
        return other.address === this.address && other.text === this.text;
      }

      toDOM() {
        const span = document.createElement("span");
        span.className = "cm-event-chip";
        span.dataset.address = this.address;
        span.dataset.text = this.text;
        span.setAttribute("role", "link");
        chips.fill(span);
        return span;
      }

      ignoreEvent(e: Event) {
        return e.type !== "mousedown";
      }
    }
    const source = (line: { from: number; text: string }, view: EditorView): Preview[] => {
      const out: Preview[] = [];
      for (const m of line.text.matchAll(EVENT_LINK)) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        // A link in code stays code.
        const node = syntaxTree(view.state).resolveInner(from + 1, 1);
        if (/Code|Comment/.test(node.name) || /Code/.test(node.parent?.name ?? "")) continue;
        out.push({ from, to, decoration: Decoration.replace({ widget: new Chip(m[2], m[1]) }), span: { from, to } });
      }
      return out;
    };
    return [
      livePreview(source),
      EditorView.domEventHandlers({
        mousedown: (e) => {
          const chip = (e.target as HTMLElement).closest<HTMLElement>(".cm-event-chip");
          if (!chip || e.button !== 0) return false;
          e.preventDefault();
          const known = this.known.get(chip.dataset.address!);
          this.show(chip.dataset.address!, known && "found" in known ? known.found : null);
          return true;
        },
      }),
    ];
  }

  /** Fill a chip from what's known of its event, asking for it the first time. */
  private fill(span: HTMLElement) {
    const address = span.dataset.address!;
    const known = this.known.get(address);
    span.replaceChildren();
    span.classList.toggle("is-missing", !!known && "missing" in known);
    const dot = document.createElement("span");
    dot.className = "cm-event-chip-dot";
    const when = document.createElement("span");
    when.className = "cm-event-chip-when";
    const title = document.createElement("span");
    title.className = "cm-event-chip-title";
    if (known && "found" in known) {
      const calendar = known.found.event.calendar;
      void this.colors?.then((c) => c.get(calendar) && dot.style.setProperty("background", c.get(calendar)!));
      when.textContent = whenLabel(known.found);
      title.textContent = known.found.event.title || span.dataset.text || "(No title)";
      span.title = `${known.found.event.title}${known.found.event.location ? ` · ${known.found.event.location}` : ""}: show it in the calendar`;
    } else {
      title.textContent = span.dataset.text || "Event";
      span.title = known ? "This event isn't in your calendar any more" : "";
    }
    span.append(dot, when, title);
    if (!known) void this.ask(address);
  }

  private async ask(address: string) {
    if (this.asking.has(address)) return;
    this.asking.add(address);
    this.colors ??= this.ctx.data.calendar.calendars().then((cs) => new Map(cs.map((c) => [c.id, c.color])), () => new Map());
    try {
      const found = await this.ctx.data.calendar.event(address);
      this.known.set(address, found ? { found } : { missing: true });
    } catch {
      // Not allowed, or offline: the chip stays as its link's text, and is asked again next time.
      this.asking.delete(address);
      return;
    }
    this.asking.delete(address);
    for (const span of document.querySelectorAll<HTMLElement>(`.cm-event-chip[data-address="${CSS.escape(address)}"]`)) this.fill(span);
  }

  /** Events changed: ask again about every event a chip shows. */
  refresh() {
    const addresses = [...this.known.keys()];
    this.known.clear();
    for (const a of addresses) void this.ask(a);
  }
}

/** A link to an event, as a note holds it: "[Team sync](event:…)". */
export const linkTo = (o: Pick<Occurrence, "title" | "address">) => `[${(o.title || "Event").replace(/[[\]]/g, "")}](${o.address})`;
