// What a Preview starts with: each pull request's sample notes from examples/preview/<slug>/, and a
// "Try this PR" note that lists what to test, this PR's steps first. And the scenarios tests start
// from (test/scenarios/), each a few of those sections' notes on a fixed clock.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFilePath, type Seed } from "../worker/src/files.ts";
import { readLevers } from "../worker/src/levers.ts";
import * as L from "../web/src/layout.ts";

export interface Section {
  slug: string;
  pr: number;
  title: string;
  steps: string[];
  /** Later versions of the section's notes, by named agents, so history has something to show. */
  edits: Array<{ path: string; text: string; agent: string; label?: string }>;
  notes: Array<{ path: string; text: string }>;
}

export interface PullRequest {
  number?: number;
  title?: string;
  url?: string;
  sha?: string;
}

export const TRY_THIS_PR = "Try this PR.md";

/**
 * Every examples/preview/<slug>.json with the notes in examples/preview/<slug>/, and the files of the
 * Catalog extensions it installs ("install": ["html-app"]) from `catalog`, so a demo that needs one
 * works as the Preview opens. Throws on a malformed file.
 */
export function readSections(dir: string, catalog = path.join(dir, "../../web/public/catalog")): Section[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const slug = file.slice(0, -".json".length);
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const { pr, title, steps, edits = [], install = [] } = data ?? {};
      if (!Array.isArray(install) || !install.every((id) => typeof id === "string" && fs.existsSync(path.join(catalog, id, "extension.json"))))
        throw new Error(`${file}: "install" must be a list of the Catalog's extension ids`);
      const valid = Number.isInteger(pr) && typeof title === "string" && Array.isArray(steps) && steps.every((s) => typeof s === "string");
      if (!valid) throw new Error(`${file} must look like {"pr": 1, "title": "...", "steps": ["..."]}`);
      const editsValid = Array.isArray(edits) && edits.every((e) => e && typeof e.path === "string" && typeof e.text === "string" && typeof e.agent === "string");
      if (!editsValid) throw new Error(`${file}: "edits" must be a list of {"agent": "...", "path": "...", "text": "..."}`);
      const notes = folderFiles(path.join(dir, slug));
      return { slug, pr, title, steps, notes: [...notes, ...catalogFiles(catalog, install as string[])], edits };
    });
}

/** The workspace files in a folder: notes at the top, and others (a sample extension, say) in folders below, such as .common-ink/extensions/. */
function folderFiles(dir: string): Array<{ path: string; text: string }> {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => parseFilePath(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/** A Catalog extension's files, as workspace files, for a seed that installs it. */
function catalogFiles(catalog: string, ids: readonly string[]): Array<{ path: string; text: string }> {
  return ids.flatMap((id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(catalog, id, "extension.json"), "utf8")) as { main?: string; files?: string[] };
    const files = ["extension.json", ...new Set([manifest.main ?? "index.js", ...(manifest.files ?? [])])].map((f) => ({ path: `.common-ink/extensions/${id}/${f}`, text: fs.readFileSync(path.join(catalog, id, f), "utf8") }));
    // As installing from the Catalog leaves it: where it came from, so it says Catalog.
    return [...files, { path: `.common-ink/extensions/${id}/installed.json`, text: `${JSON.stringify({ catalog: "Common Ink" })}\n` }];
  });
}

export function tryThisPr(sections: Section[], pr: PullRequest): string {
  const ordered = [...sections].sort((a, b) => Number(b.pr === pr.number) - Number(a.pr === pr.number) || b.pr - a.pr);
  const about = [
    pr.title && `**${pr.title}**`,
    pr.url && `[open the pull request](${pr.url})`,
    pr.sha && `deployed from \`${pr.sha.slice(0, 7)}\``,
  ].filter(Boolean);
  return [
    `# Try this PR${pr.number ? ` (#${pr.number})` : ""}`,
    "",
    ...(about.length ? [about.join(" · "), ""] : []),
    "This Preview has its own notes. Change anything: each deploy adds back missing sample notes and rewrites this one.",
    "",
    ...ordered.flatMap((s) => [`## ${s.title} (#${s.pr})`, "", ...s.steps.map((step, i) => `${i + 1}. ${step}`), ""]),
  ].join("\n");
}

/**
 * "{{today}}", "{{today+3}}" and "{{today-1}}" in sample notes become dates, so due dates stay near the
 * day the Preview deploys. "{{day+3}}" is the same date written as calendar ids write it, "20261008".
 */
export function fillDates(text: string, today: string): string {
  return text.replace(/\{\{(today|day)(?:([+-])(\d+))?\}\}/g, (_, form: string, sign: string | undefined, days: string | undefined) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (sign === "-" ? -1 : 1) * Number(days ?? 0));
    const date = d.toISOString().slice(0, 10);
    return form === "day" ? date.replace(/-/g, "") : date;
  });
}

export function buildSeed(sections: Section[], pr: PullRequest, today = new Date().toISOString().slice(0, 10)): Seed {
  const notes = [
    // Kept as you edit them, unless the PR changes them (Files.seed tells).
    ...sections.flatMap((s) => s.notes.map((n) => ({ ...n, path: fillDates(n.path, today), text: fillDates(n.text, today), replace: false }))),
    { path: TRY_THIS_PR, text: tryThisPr(sections, pr), replace: true },
  ];
  const edits = sections.flatMap((s) => s.edits);
  return { id: seedId(notes, edits), notes, edits, scenario: { name: PREVIEW_SCENARIO } };
}

const seedId = (notes: Seed["notes"], edits: Seed["edits"]) => createHash("sha256").update(JSON.stringify({ notes, edits })).digest("hex").slice(0, 16);

/** The scenario a Preview starts with: every section's notes and a Try this PR note. */
export const PREVIEW_SCENARIO = "preview";

/**
 * A workspace to test against (docs/TESTING.md), as data in test/scenarios/<name>.json: the notes of
 * some Preview sections, notes of its own in test/scenarios/<name>/, the Catalog extensions it
 * installs, the clock its dates are written against, and the note it opens on.
 */
export interface Scenario {
  name: string;
  about: string;
  sections: string[];
  /** Local time ("2026-10-05T09:00"): `{{today}}` in its notes is this day, and the page's clock starts here. */
  now?: string;
  open?: string;
  notes: Array<{ path: string; text: string }>;
}

/** Every test/scenarios/<name>.json with its notes. Throws on a malformed file. */
export function readScenarios(dir: string, catalog = path.join(dir, "../../web/public/catalog")): Scenario[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".json".length);
      const { about, sections = [], install = [], now, open } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) ?? {};
      const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
      if (typeof about !== "string" || !strings(sections) || !strings(install)) throw new Error(`${file} must look like {"about": "...", "sections": ["lists"], "install": []}`);
      if (now !== undefined && (typeof now !== "string" || readLevers(new URLSearchParams({ now })).now !== now || now === "real")) throw new Error(`${file}: "now" must be a local time like "2026-10-05T09:00"`);
      if (!(install as string[]).every((id) => fs.existsSync(path.join(catalog, id, "extension.json")))) throw new Error(`${file}: "install" must be a list of the Catalog's extension ids`);
      if (open !== undefined && typeof open !== "string") throw new Error(`${file}: "open" must be a note's path`);
      return { name, about, sections, now, open, notes: [...folderFiles(path.join(dir, name)), ...catalogFiles(catalog, install)] };
    });
}

/** A scenario's seed: its sections' notes and its own, dated from its clock, opening on its note. */
export function scenarioSeed(scenario: Scenario, sections: Section[], today = new Date().toISOString().slice(0, 10)): Seed {
  const picked = scenario.sections.map((slug) => {
    const section = sections.find((s) => s.slug === slug);
    if (!section) throw new Error(`Scenario ${scenario.name}: no examples/preview/${slug}.json`);
    return section;
  });
  const day = scenario.now?.slice(0, 10) ?? today;
  const notes = [...picked.flatMap((s) => s.notes), ...scenario.notes].map((n) => ({ ...n, path: fillDates(n.path, day), text: fillDates(n.text, day), replace: false }));
  if (scenario.open) {
    const open = parseFilePath(scenario.open);
    if (!open || !notes.some((n) => n.path === open)) throw new Error(`Scenario ${scenario.name} opens ${scenario.open}, which it doesn't have`);
    notes.push({ path: L.LAYOUT_PATH, text: `${JSON.stringify(L.openTab(L.emptyLayout(), open), null, 2)}\n`, replace: false });
  }
  const edits = picked.flatMap((s) => s.edits);
  return { id: seedId(notes, edits), notes, edits, scenario: { name: scenario.name, ...(scenario.now ? { now: scenario.now } : {}) } };
}
