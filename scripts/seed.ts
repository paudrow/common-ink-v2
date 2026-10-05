// What a Preview starts with: each pull request's sample notes from examples/preview/<slug>/, and a
// "Try this PR" note that lists what to test, this PR's steps first.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFilePath, type Seed } from "../worker/src/files.ts";

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
      const notesDir = path.join(dir, slug);
      // Notes at the top, and other workspace files (a sample extension, say) in folders below, such as .common-ink/extensions/.
      const notes = fs.existsSync(notesDir)
        ? (fs.readdirSync(notesDir, { recursive: true }) as string[])
            .map((f) => f.split(path.sep).join("/"))
            .filter((f) => parseFilePath(f) && fs.statSync(path.join(notesDir, f)).isFile())
            .sort()
            .map((f) => ({ path: f, text: fs.readFileSync(path.join(notesDir, f), "utf8") }))
        : [];
      const installed = (install as string[]).flatMap((id) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(catalog, id, "extension.json"), "utf8")) as { main?: string; files?: string[] };
        const files = ["extension.json", ...new Set([manifest.main ?? "index.js", ...(manifest.files ?? [])])].map((f) => ({ path: `.common-ink/extensions/${id}/${f}`, text: fs.readFileSync(path.join(catalog, id, f), "utf8") }));
        // As installing from the Catalog leaves it: where it came from, so it says Catalog.
        return [...files, { path: `.common-ink/extensions/${id}/installed.json`, text: `${JSON.stringify({ catalog: "Common Ink" })}\n` }];
      });
      return { slug, pr, title, steps, notes: [...notes, ...installed], edits };
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

/** "{{today}}", "{{today+3}}" and "{{today-1}}" in sample notes become dates, so due dates stay near the day the Preview deploys. */
export function fillDates(text: string, today: string): string {
  return text.replace(/\{\{today(?:([+-])(\d+))?\}\}/g, (_, sign: string | undefined, days: string | undefined) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (sign === "-" ? -1 : 1) * Number(days ?? 0));
    return d.toISOString().slice(0, 10);
  });
}

export function buildSeed(sections: Section[], pr: PullRequest, today = new Date().toISOString().slice(0, 10)): Seed {
  const notes = [
    // Kept as you edit them, unless the PR changes them (Files.seed tells).
    ...sections.flatMap((s) => s.notes.map((n) => ({ ...n, text: fillDates(n.text, today), replace: false }))),
    { path: TRY_THIS_PR, text: tryThisPr(sections, pr), replace: true },
  ];
  const edits = sections.flatMap((s) => s.edits);
  const id = createHash("sha256").update(JSON.stringify({ notes, edits })).digest("hex").slice(0, 16);
  return { id, notes, edits };
}
