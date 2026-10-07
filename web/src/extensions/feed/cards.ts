// What a Feed card shows of a note, worked out from its text without drawing anything: a few lines, as
// plain words with the markdown's marks taken off, and each embed as one quiet line saying what it is
// (study, section 5.2, decision 19), so a feed of notes never runs a timer or loads a frame. And which
// date group a card goes under.

export type LineKind = "text" | "heading" | "item" | "task" | "done" | "embed";

export interface PreviewLine {
  kind: LineKind;
  text: string;
}

/** Links and emphasis as their words: [[Plan|the plan]] is "the plan", [site](url) is "site". */
function plain(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
    .trim();
}

/** An embed's directive arguments as a few words: {duration=25m label="Focus"} is "25m · Focus". */
function argWords(args: string | undefined): string[] {
  if (!args) return [];
  return [...args.matchAll(/[\w-]+=(?:"([^"]*)"|(\S+))/g)].map((m) => m[1] ?? m[2]).filter(Boolean).slice(0, 3);
}

const named = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/**
 * The first `max` lines worth showing of a note: its title heading, blank lines and rules left out;
 * tasks, list items and headings marked as what they are; and each embed (`::timer{…}`, a `:::kanban`
 * block, a fenced block) a single quiet line naming it.
 */
export function previewLines(text: string, max = 5): PreviewLine[] {
  const lines = text.split("\n");
  const out: PreviewLine[] = [];
  let i = 0;
  // The title is the card's own: a first `# heading` isn't repeated under it.
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^#\s/.test(lines[i] ?? "")) i++;
  for (; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;
    const fence = /^(`{3,}|~{3,})\s*([\w-]*)/.exec(t);
    const block = /^:::\s*([\w-]+)(\{.*\})?/.exec(t);
    if (fence || block) {
      const close = fence ? fence[1] : ":::";
      const name = fence ? fence[2] || "code" : block![1];
      out.push({ kind: "embed", text: [named(name), ...argWords(block?.[2])].join(" · ") });
      while (++i < lines.length && !lines[i].trim().startsWith(close));
      continue;
    }
    const directive = /^::([\w-]+)(\{.*\})?\s*$/.exec(t);
    if (directive) {
      out.push({ kind: "embed", text: [named(directive[1]), ...argWords(directive[2])].join(" · ") });
      continue;
    }
    const task = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(t);
    if (task) {
      out.push({ kind: task[1] === " " ? "task" : "done", text: plain(task[2]) });
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (item) {
      out.push({ kind: "item", text: plain(item[1]) });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(t);
    if (heading) {
      out.push({ kind: "heading", text: plain(heading[1]) });
      continue;
    }
    out.push({ kind: "text", text: plain(t.replace(/^>\s?/, "")) });
  }
  return out;
}

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The date group a change at `time` goes under, in local time: Today, Yesterday, This week, This month, or its month ("September 2026"). */
export function dateGroup(time: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(time)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  const [a, b] = [new Date(time), new Date(now)];
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return "This month";
  return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
}
