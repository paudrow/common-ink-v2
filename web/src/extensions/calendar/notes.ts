// Notes about events: the ones that link to an event, listed in its editor, and a meeting note made
// for it, linked, in the meeting notes folder (calendar.meetingNotes). With calendar.linkBack on, the
// event's description gets a link back to the note too, which changes it for everyone invited, so it's
// off unless you turn it on.
import type { Occurrence } from "common-ink/calendar";
import type { FilePath } from "../../../../worker/src/files.ts";
import type { EventFound } from "../../../../worker/src/operations.ts";
import type { ExtensionContext } from "../../extension-api.ts";
import { el, icon } from "./dom.ts";
import { closePopover } from "./editor.ts";
import { linkTo, whenLabel } from "./links.ts";

/** "Meetings/2026-10-05 Team standup.md": the meeting note's path for an event. */
export function meetingNotePath(folder: string, day: string, title: string): FilePath {
  const name = `${day} ${title || "Meeting"}`.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  return `${folder.replace(/^\/+|\/+$/g, "")}${folder ? "/" : ""}${name}.md` as FilePath;
}

/** Make an event's meeting note (or find the one there is), linked to it, and open it. */
export async function meetingNote(ctx: ExtensionContext, o: Occurrence, found: EventFound | null, day: string): Promise<void> {
  const path = meetingNotePath(ctx.settings.get<string>("calendar.meetingNotes") ?? "Meetings", day, o.title);
  const current = await ctx.files.read(path);
  if (!current.text) {
    const when = found ? whenLabel(found) : day;
    await ctx.files.write(path, `# ${o.title || "Meeting"}\n\n${linkTo(o)} · ${when}\n\n## Notes\n\n- \n`, current.revision);
    if (ctx.settings.get<boolean>("calendar.linkBack") && found) {
      const back = `Notes: ${location.origin}/?file=${encodeURIComponent(path)}`;
      const description = found.event.description ?? "";
      if (!description.includes(back)) await ctx.data.calendar.update(o.address, { description: description ? `${description}\n\n${back}` : back }, o.series ? "this" : undefined).catch(() => {});
    }
  }
  closePopover();
  await ctx.workbench.open(path, { newTab: true });
}

/** The editor's Notes: the notes that link here (or to the series), and Create meeting note. */
export function notesSection(ctx: ExtensionContext, o: Occurrence, found: EventFound | null, day: string): HTMLElement {
  const notes = found?.notes ?? [];
  return el(
    "div",
    { class: "cal-field cal-notes" },
    el("span", { class: "cal-field-icon", title: "Notes" }, icon("note", 15)),
    el(
      "div",
      { class: "cal-stack" },
      ...notes.map((n) =>
        el(
          "button",
          {
            type: "button",
            class: "cal-note-link",
            title: n.series ? "Links to every occurrence" : "Links to this one",
            onclick: () => {
              closePopover();
              void ctx.workbench.open(n.path, { newTab: true });
            },
          },
          n.title,
          n.series ? el("span", { class: "cal-muted" }, " · all occurrences") : null,
        ),
      ),
      el("button", { type: "button", class: "qw-btn cal-meeting-note", onclick: () => void meetingNote(ctx, o, found, day) }, notes.length ? "New meeting note" : "Create meeting note"),
    ),
  );
}
