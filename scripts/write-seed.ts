// Write dist/seed.json, which a Preview (or `npm run dev`) fills its workspace from.
//
//   node --import tsx scripts/write-seed.ts
//
// PR_NUMBER, PR_TITLE, PR_URL and PR_SHA describe the pull request; CI sets them.
import fs from "node:fs";
import path from "node:path";
import { buildSeed, readSections } from "./seed.ts";

const root = path.resolve(import.meta.dirname, "..");
const { PR_NUMBER, PR_TITLE, PR_URL, PR_SHA } = process.env;
const seed = buildSeed(readSections(path.join(root, "examples/preview")), {
  number: PR_NUMBER ? Number(PR_NUMBER) : undefined,
  title: PR_TITLE,
  url: PR_URL,
  sha: PR_SHA,
});
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/seed.json"), JSON.stringify(seed));
console.log(`Wrote dist/seed.json: ${seed.notes.length} notes`);
