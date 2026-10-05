// What a Preview starts with: each pull request's sample notes from examples/preview/<slug>/, and a
// "Try this PR" note that lists what to test, this PR's steps first.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Seed } from "../worker/src/files.ts";

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

/** Every examples/preview/<slug>.json with the notes in examples/preview/<slug>/. Throws on a malformed file. */
export function readSections(dir: string): Section[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const slug = file.slice(0, -".json".length);
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const { pr, title, steps, edits = [] } = data ?? {};
      const valid = Number.isInteger(pr) && typeof title === "string" && Array.isArray(steps) && steps.every((s) => typeof s === "string");
      if (!valid) throw new Error(`${file} must look like {"pr": 1, "title": "...", "steps": ["..."]}`);
      const editsValid = Array.isArray(edits) && edits.every((e) => e && typeof e.path === "string" && typeof e.text === "string" && typeof e.agent === "string");
      if (!editsValid) throw new Error(`${file}: "edits" must be a list of {"agent": "...", "path": "...", "text": "..."}`);
      const notesDir = path.join(dir, slug);
      const notes = fs.existsSync(notesDir)
        ? fs
            .readdirSync(notesDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => ({ path: f, text: fs.readFileSync(path.join(notesDir, f), "utf8") }))
        : [];
      return { slug, pr, title, steps, notes, edits };
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

export function buildSeed(sections: Section[], pr: PullRequest): Seed {
  const notes = [
    ...sections.flatMap((s) => s.notes.map((n) => ({ ...n, replace: false }))),
    { path: TRY_THIS_PR, text: tryThisPr(sections, pr), replace: true },
  ];
  const edits = sections.flatMap((s) => s.edits);
  const id = createHash("sha256").update(JSON.stringify({ notes, edits })).digest("hex").slice(0, 16);
  return { id, notes, edits };
}
