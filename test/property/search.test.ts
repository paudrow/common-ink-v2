import assert from "node:assert/strict";
import { test } from "node:test";
import { Files, type Author, type FilePath } from "../../worker/src/files.ts";
import { format, parse, select, titleOf, type Query, type Term } from "../../worker/src/query.ts";
import { SearchIndex } from "../../worker/src/search.ts";
import { memoryDb } from "../sqlite.ts";
import { forAll, type Rng } from "./gen.ts";

const WORDS = ["launch", "Launched", "beta", "date", "résumé", "resume", "cafe\u0301", "e-mail", "mail", "plan", "la", "b", "東京", "タワー", "c++", "Straße", "x9", "ship", "한국", "여행", "мой", "мои", "がっこう", "かっこう", "पाठ", "पठ", "שָׁלוֹם", "שלום", "كَتَبَ", "Άλφα", "re🙂port", "ＡＢＣ", "İstanbul", "x²", "ภาษาไทย", "ﬁle"];
const AUTHORS: Author[] = [
  { kind: "user", email: "ada@example.com" },
  { kind: "agent", name: "Claude", by: "ada@example.com" },
  { kind: "sync", source: "google-calendar" },
];

const line = (r: Rng) => r.array(0, 6, () => r.pick([...WORDS, "-", ",", "\t", "- [ ]", "::timer{}"])).join(r.pick([" ", " ", "-", ""]));
const note = (r: Rng) => ({
  path: `${r.pick(["", "Projects/", "Journal/"])}${r.pick(WORDS).replace(/\W/g, "")}${r.int(0, 9)}.md`,
  text: [r.bool() ? `# ${line(r)}` : line(r), ...r.array(0, 4, line)].join("\n"),
  author: r.pick(AUTHORS),
});
const term = (r: Rng): Term =>
  r.bool(0.75)
    ? { kind: "words", text: r.array(1, r.bool(0.3) ? 3 : 1, () => r.pick(WORDS).slice(0, r.int(1, 8))).join(" "), negated: r.bool(0.2) }
    : { kind: "filter", key: r.pick(["in", "from", "has"]), value: r.pick(["Projects", "agent", "me", "task", "embed"]), negated: r.bool(0.3) };

test("searching through the index finds exactly what the matcher finds over every note, in the same order", () => {
  forAll(
    (r) => ({ notes: r.array(0, 12, note), deletes: r.array(0, 3, () => r.int(0, 11)), query: { terms: r.array(1, 3, term) } as Query }),
    ({ notes, deletes, query }) => {
      let clock = 1_000;
      const db = memoryDb();
      const index = new SearchIndex(db);
      const files = new Files(db, () => (clock += 1_000), undefined, (path, text, revision) => index.observe(path, text, revision));
      for (const n of notes) {
        const current = files.read(n.path as FilePath);
        files.write({ path: n.path as FilePath, text: n.text, base: current?.revision ?? 0, author: n.author });
      }
      for (const i of deletes) {
        const victim = notes[i] && files.read(notes[i].path as FilePath);
        if (victim) files.write({ path: victim.path, text: "", base: victim.revision, author: AUTHORS[0], delete: true });
      }
      const ctx = { now: clock, zone: "UTC" };
      const every = db
        .all<{ path: string; text: string; author: string; time: number }>("SELECT f.path, f.text, c.author, c.time FROM files f JOIN changes c ON c.revision = f.revision")
        .map((f) => ({ path: f.path, title: titleOf(f.path, f.text), text: f.text, edited: f.time, author: JSON.parse(f.author) as Author }));
      const q = format(query);
      const expected = select(parse(q), every, ctx).map((n) => n.path);
      assert.deepEqual(index.search(parse(q), { ctx, limit: 100 }).results.map((r) => r.path), expected, q);
    },
    { runs: 1500 },
  );
});
