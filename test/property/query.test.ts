import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author } from "../../worker/src/files.ts";
import { format, matches, parse, select, type MatchContext, type NoteFacts, type Query, type Term } from "../../worker/src/query.ts";
import { forAll, type Rng } from "./gen.ts";

const EXTRA = ["due"];
const KEYS = ["is", "in", "from", "type", "edited", "has", "sort", "due"];
const WORDS = ["launch", "beta", "date", "résumé", "resume", "e-mail", "mail", "plan", "la", "b", "東京", "c++", "-", "--x", "is:archived", "http://x.io", "", "한국", "мой", "мои", "がっこう", "かっこう", "पाठ", "पठ", "שלום", "שָׁלוֹם", "Άλφα", "cafe\u0301"];
const VALUES: Record<string, string[]> = {
  is: ["archived", "pinned", "trashed", "open", "done", "shiny", ""],
  in: ["Projects", "Projects/", "projects/", "Journal", "My Folder/", "Projects/Sub", ""],
  from: ["me", "agent", "sync", "extension", "claude", "Claude", "ada@example.com", "google-calendar", "tasks", ""],
  type: ["note", "task", "event", "Note"],
  edited: ["today", "yesterday", "<7d", ">2d", "<1w", ">1m", "<=2026-10-04", ">=2026-10-04", "2026-10-05", "<2026-10-05", "soon", ""],
  has: ["task", "embed", "event", "nothing"],
  sort: ["edited", "title", "relevance"],
  due: ["today"],
};

const term = (r: Rng): Term => {
  const negated = r.bool(0.3);
  if (r.bool(0.45)) {
    const text = r.bool(0.25) ? `${r.pick(WORDS)} ${r.pick(WORDS)}` : r.pick(WORDS);
    return { kind: "words", text, negated };
  }
  const key = r.pick(KEYS);
  return { kind: "filter", key, value: r.pick(VALUES[key]), negated };
};
const query = (r: Rng): Query => ({ terms: r.array(0, 5, term) });

test("a query written out reads back as the same query", () => {
  forAll(query, (q) => assert.deepEqual(parse(format(q, EXTRA), EXTRA), q, format(q, EXTRA)), { runs: 2000 });
});

test("any text reads as a query that writes out and reads back the same", () => {
  const CHARS = ['a', 'b', 'é', ' ', ' ', '-', '"', ':', 'is', 'in', 'due', '/', 'x', '\t', '#'];
  forAll(
    (r) => r.array(0, 16, () => r.pick(CHARS)).join(""),
    (text) => {
      const once = parse(text, EXTRA);
      assert.deepEqual(parse(format(once, EXTRA), EXTRA), once, JSON.stringify(text));
    },
    { runs: 3000 },
  );
});

const NOW = Date.parse("2026-10-05T15:00:00Z");
const DAY = 86_400_000;
const AUTHORS: Author[] = [
  { kind: "user", email: "ada@example.com" },
  { kind: "agent", name: "Claude", by: "ada@example.com" },
  { kind: "agent", name: "Codex" },
  { kind: "extension", id: "tasks", by: "ada@example.com" },
  { kind: "sync", source: "google-calendar" },
];
const LINES = ["Ship the beta on Oct 20.", "- [ ] Record the demo", "* [x] done", "::timer{duration=25m}", "[Standup](event:sample/work/x)", "Résumé e-mail", "東京タワー", "launch party", "c++ and la", "한국 여행", "мой план", "がっこう", "हिन्दी पाठ", "שָׁלוֹם", "άλφα βήτα", "re🙂port"];
const FOLDERS = ["Projects/", "Projects/Sub/", "Journal/", "My Folder/", "", "projectsX/"];

const noteFacts = (r: Rng): NoteFacts => {
  const title = r.pick(["Launch plan", "Beta date", "Groceries", "Résumé", "Plan"]);
  return {
    path: `${r.pick(FOLDERS)}${title}.md`,
    title,
    text: [`# ${title}`, ...r.array(0, 4, () => r.pick(LINES))].join("\n"),
    edited: NOW - r.int(0, 120) * (DAY / 4),
    author: r.pick(AUTHORS),
    ...(r.bool(0.3) ? { archived: true } : {}),
    ...(r.bool(0.3) ? { pinned: true } : {}),
    ...(r.bool(0.2) ? { trashed: true } : {}),
  };
};

/** The reference: the language's rules written out plainly, one if at a time. */
function reference(q: Query, n: NoteFacts, ctx: MatchContext): boolean {
  // Marks go only after a letter whose accents are optional; a mark after anything else stays.
  const optional = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}]/u;
  const words = (s: string) => {
    let out = "";
    let base = "";
    for (const ch of s.normalize("NFD")) {
      if (/\p{M}/u.test(ch) && optional.test(base)) continue;
      if (!/\p{M}/u.test(ch)) base = ch;
      out += ch;
    }
    return out.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u).filter(Boolean);
  };
  const hay = ` ${words(`${n.title}\n${n.text}`).join(" ")}`;
  const isTrashedAsked = q.terms.some((t) => t.kind === "filter" && t.key === "is" && !t.negated && t.value.toLowerCase() === "trashed");
  if (n.trashed && !isTrashedAsked) return false;
  for (const t of q.terms) {
    if (t.kind !== "words" || words(t.text).length === 0) continue;
    if (hay.includes(` ${words(t.text).join(" ")}`) === t.negated) return false;
  }
  const day = (time: number) => new Date(time).toLocaleDateString("sv-SE", { timeZone: ctx.zone });
  const today = day(ctx.now);
  const yesterday = day(ctx.now - DAY);
  const edited = (v: string): boolean => {
    const age = /^([<>])(\d+)([dwm])$/.exec(v);
    if (age) {
      const ms = Number(age[2]) * { d: DAY, w: 7 * DAY, m: 30 * DAY }[age[3] as "d"];
      return age[1] === "<" ? ctx.now - n.edited < ms : ctx.now - n.edited > ms;
    }
    const m = /^(<=|>=|<|>)?(.*)$/.exec(v)!;
    const target = m[2] === "today" ? today : m[2] === "yesterday" ? yesterday : m[2];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;
    const d = day(n.edited);
    return { "": d === target, "<": d < target, "<=": d <= target, ">": d > target, ">=": d >= target }[m[1] ?? ""]!;
  };
  const from = (v: string): boolean => {
    const a = n.author;
    const lower = v.toLowerCase();
    if (lower === "me") return a.kind === "user";
    if (lower === "agent" || lower === "sync" || lower === "extension") return a.kind === lower;
    const name = a.kind === "user" ? a.email : a.kind === "agent" ? a.name : a.kind === "extension" ? a.id : a.source;
    return name.toLowerCase() === lower;
  };
  const passes = (key: string, v: string): boolean | "never" => {
    const lower = v.toLowerCase();
    if (key === "is") return lower === "open" || lower === "done" ? "never" : lower === "archived" ? !!n.archived : lower === "pinned" ? !!n.pinned : lower === "trashed" ? !!n.trashed : false;
    if (key === "in") return n.path.toLowerCase().startsWith(`${lower.replace(/\/+$/, "")}/`);
    if (key === "from") return from(v);
    if (key === "type") return lower === "note";
    if (key === "edited") return edited(v);
    if (key === "has") return lower === "task" ? n.text.split("\n").some((l) => /^\s*[-*+] \[[ xX]\]/.test(l)) : lower === "embed" ? n.text.split("\n").some((l) => /^:{2,3}[a-zA-Z]/.test(l)) : lower === "event" ? n.text.includes("](event:") : false;
    if (key === "sort") return true;
    return "never";
  };
  const filters = q.terms.filter((t): t is Extract<Term, { kind: "filter" }> => t.kind === "filter" && t.value !== "" && t.key !== "sort");
  if (filters.some((t) => passes(t.key, t.value) === "never")) return false;
  for (const key of ["in", "from", "type"]) {
    const wanted = filters.filter((t) => t.key === key && !t.negated);
    if (wanted.length && !wanted.some((t) => passes(key, t.value) === true)) return false;
  }
  return filters.every((t) => (["in", "from", "type"].includes(t.key) && !t.negated) || passes(t.key, t.value) === !t.negated);
}

test("the matcher agrees with the reference on every note and query", () => {
  const ctx = { now: NOW, zone: "America/New_York" };
  forAll(
    (r) => ({ q: format(query(r), EXTRA), notes: r.array(1, 8, noteFacts) }),
    ({ q, notes }) => {
      const parsed = parse(q, EXTRA);
      for (const n of notes) assert.equal(matches(parsed, n, ctx), reference(parsed, n, ctx), `${q} on ${JSON.stringify(n)}`);
    },
    { runs: 3000 },
  );
});

test("results are the matching notes, archived ones last, newest first when sorted by edited", () => {
  const ctx = { now: NOW, zone: "Asia/Tokyo" };
  forAll(
    (r) => ({ q: `${format(query(r), EXTRA)} sort:edited`, notes: r.array(0, 12, noteFacts) }),
    ({ q, notes }) => {
      const parsed = parse(q, EXTRA);
      const out = select(parsed, notes, ctx);
      assert.deepEqual(new Set(out), new Set(notes.filter((n) => reference(parsed, n, ctx))));
      for (let i = 1; i < out.length; i++) {
        const [a, b] = [out[i - 1], out[i]];
        assert.ok(!a.archived || b.archived, "archived notes come last");
        if (!!a.archived === !!b.archived) assert.ok(a.edited >= b.edited, "newest first");
      }
    },
    { runs: 1000 },
  );
});
