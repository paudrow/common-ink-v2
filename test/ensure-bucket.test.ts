import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "ensure-bucket.sh");
const BUCKET = "common-ink-v2-uploads";

/** What a stubbed `npx wrangler …` does: one rule per subcommand, each a list of answers used in turn (the last repeats). */
interface Answer {
  code: number;
  out: string;
}
function run(bucket: string, stub: { list: Answer[]; create?: Answer[]; info?: Answer[] }) {
  const dir = mkdtempSync(join(tmpdir(), "ensure-bucket-"));
  const calls = join(dir, "calls");
  const script = (name: string, answers: Answer[] = [{ code: 1, out: "unexpected" }]) =>
    writeFileSync(join(dir, name), answers.map((a, i) => `${i}|${a.code}|${a.out}`).join("\n"));
  script("list", stub.list);
  script("create", stub.create);
  script("info", stub.info);
  // The stub counts each subcommand's calls in `<dir>/<name>.n` and answers from its rule.
  writeFileSync(
    join(dir, "npx"),
    `#!/bin/bash
echo "$*" >> "${calls}"
[ "$1" = wrangler ] && [ "$2" = r2 ] && [ "$3" = bucket ] || exit 9
name=$4
n=$(cat "${dir}/$name.n" 2>/dev/null || echo 0)
echo $((n + 1)) > "${dir}/$name.n"
total=$(wc -l < "${dir}/$name"); total=$((total + 1))
i=$(( n < total ? n : total - 1 ))
IFS='|' read -r _ code out < <(sed -n "$((i + 1))p" "${dir}/$name")
printf '%b\\n' "$out"
exit "$code"
`,
  );
  chmodSync(join(dir, "npx"), 0o755);
  const result = spawnSync("bash", [SCRIPT, bucket], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ENSURE_BUCKET_PAUSE: "0" }, encoding: "utf8" });
  let log: string[] = [];
  try {
    log = readFileSync(calls, "utf8").trim().split("\n");
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: log };
}

const listing = (...names: string[]) => ({ code: 0, out: `Listing buckets...\\n` + names.map((n) => `name:           ${n}\\ncreation_date:  2026-01-01T00:00:00.000Z`).join("\\n\\n") });
const limited = { code: 1, out: "A request to the Cloudflare API failed [code: 10429] Too many requests" };

test("a bucket in the list is left alone, and nothing is created or looked up one by one", () => {
  const r = run(BUCKET, { list: [listing("other", BUCKET)] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /is there/);
  assert.deepEqual(r.calls, ["wrangler r2 bucket list"]);
});

test("a longer or shorter name that merely contains the bucket's name doesn't count", () => {
  const r = run(BUCKET, { list: [listing(`${BUCKET}-preview`, `x${BUCKET}`, "common-ink-v2")], create: [{ code: 0, out: "Created" }] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Made R2 bucket/);
  assert.deepEqual(r.calls, ["wrangler r2 bucket list", `wrangler r2 bucket create ${BUCKET}`]);
  const preview = run(`${BUCKET}-preview`, { list: [listing(`${BUCKET}-preview`)] });
  assert.match(preview.stdout, /is there/);
});

test("a missing bucket is made", () => {
  const r = run(BUCKET, { list: [listing()], create: [{ code: 0, out: "Created bucket" }] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Made R2 bucket/);
});

test("a failed create is fine when the bucket is in the list afterwards", () => {
  const r = run(BUCKET, { list: [listing("other"), listing(BUCKET)], create: [{ code: 1, out: "The bucket already exists [code: 10004]" }] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /is there/);
  assert.deepEqual(r.calls, ["wrangler r2 bucket list", `wrangler r2 bucket create ${BUCKET}`, "wrangler r2 bucket list"]);
});

test("a failed create with the bucket still missing fails and says what to do", () => {
  const r = run(BUCKET, { list: [listing("other")], create: [{ code: 1, out: "Authentication error [code: 10000]" }] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::Couldn't find or make the R2 bucket common-ink-v2-uploads/);
  assert.match(r.stderr, /10000/);
});

test("a rate-limited list is tried again", () => {
  const r = run(BUCKET, { list: [limited, limited, listing(BUCKET)] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /is there/);
  assert.equal(r.calls.length, 3);
});

test("a list that stays rate limited falls through to create, and a create that works is enough", () => {
  const r = run(BUCKET, { list: [limited], create: [{ code: 0, out: "Created" }] });
  assert.equal(r.status, 0);
  assert.equal(r.calls.filter((c) => c.includes("list")).length, 4);
  assert.match(r.stdout, /Made R2 bucket/);
});

test("it never asks about one bucket with `bucket info`", () => {
  const r = run(BUCKET, { list: [listing()], create: [{ code: 1, out: "no" }] });
  assert.equal(r.status, 1);
  assert.ok(r.calls.every((c) => !c.includes("info")));
});
