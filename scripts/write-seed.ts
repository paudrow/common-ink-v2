// Write dist/seed.json, which a Preview (or `npm run dev`) fills its workspace from, and what test levers
// reset to: every scenario's seed in dist/levers/scenarios/, and the recorded network in dist/levers/net.json.
//
//   node --import tsx scripts/write-seed.ts [--scenario lists]
//
// PR_NUMBER, PR_TITLE, PR_URL and PR_SHA describe the pull request; CI sets them. SCENARIO (or
// --scenario) picks the seed.json scenario; without one it's the Preview's own, every section's notes.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildSeed, PREVIEW_SCENARIO, readScenarios, readSections, scenarioSeed } from "./seed.ts";

const root = path.resolve(import.meta.dirname, "..");
const { PR_NUMBER, PR_TITLE, PR_URL, PR_SHA } = process.env;
const { values } = parseArgs({ options: { scenario: { type: "string", default: process.env.SCENARIO || PREVIEW_SCENARIO } } });
const sections = readSections(path.join(root, "examples/preview"));
const scenarios = [
  { name: PREVIEW_SCENARIO, about: "Every Preview's sample notes, and a Try this PR note.", seed: buildSeed(sections, { number: PR_NUMBER ? Number(PR_NUMBER) : undefined, title: PR_TITLE, url: PR_URL, sha: PR_SHA }) },
  ...readScenarios(path.join(root, "test/scenarios")).map((s) => ({ name: s.name, about: s.about, seed: scenarioSeed(s, sections) })),
];
const seed = scenarios.find((s) => s.name === values.scenario)?.seed;
if (!seed) throw new Error(`No scenario ${values.scenario}: there's ${scenarios.map((s) => s.name).join(", ")}`);

const dist = path.join(root, "dist");
fs.mkdirSync(path.join(dist, "levers/scenarios"), { recursive: true });
fs.writeFileSync(path.join(dist, "seed.json"), JSON.stringify(seed));
for (const s of scenarios) fs.writeFileSync(path.join(dist, `levers/scenarios/${s.name}.json`), JSON.stringify(s.seed));
fs.writeFileSync(path.join(dist, "levers/scenarios.json"), JSON.stringify(scenarios.map(({ name, about }) => ({ name, about }))));
fs.copyFileSync(path.join(root, "test/fixtures/net.json"), path.join(dist, "levers/net.json"));
console.log(`Wrote dist/seed.json (${values.scenario}, ${seed.notes.length} files) and ${scenarios.length} scenarios to reset to`);
