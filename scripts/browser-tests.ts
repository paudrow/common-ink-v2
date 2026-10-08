// Runs test/browser/*.browser.ts, or with SHARD=k/n the kth of n shards: every file is in exactly one.
// Node's own --test-shard deals files out by name, which put several of the slowest in one shard and left
// another with little; SLOW, the files that take a minute and a half or more in CI, slowest first, are
// dealt out before the rest. Arguments go on to node --test, such as --test-name-pattern.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SLOW = [
  "regressions-saving.browser.ts",
  "regressions-undone-edits.browser.ts",
  "regressions.browser.ts",
  "regressions-undo.browser.ts",
  "leaks.browser.ts",
];

const all = fs.readdirSync("test/browser").filter((f) => f.endsWith(".browser.ts")).sort();
for (const f of SLOW) if (!all.includes(f)) throw new Error(`SLOW names ${f}, which isn't in test/browser`);
const [k, n] = (process.env.SHARD ?? "1/1").split("/").map(Number);
if (!(Number.isInteger(k) && Number.isInteger(n) && 1 <= k && k <= n)) throw new Error(`SHARD=${process.env.SHARD} isn't k/n`);

const dealt = [...SLOW, ...all.filter((f) => !SLOW.includes(f))];
const files = dealt.filter((_, i) => i % n === k - 1).map((f) => `test/browser/${f}`);
const args = ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--test", `--test-concurrency=${process.env.BROWSER_CONCURRENCY ?? 4}`, ...process.argv.slice(2), ...files];
process.exit(spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1);
