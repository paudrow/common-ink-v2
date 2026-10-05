// The app on this machine: the Worker, its Durable Object and the web app, signed in as a dev user, with
// test levers on and the workspace seeded from a scenario (docs/TESTING.md).
//
//   npm run dev -- [--scenario lists] [--port 8787] [--fresh]
//
// Each scenario keeps its own workspace on disk (.wrangler/scenarios/<name>), so switching between them
// keeps what you did in each; without --scenario it's the Preview's notes, kept where they always were.
// --fresh resets the workspace to its scenario once the server is up.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { scenario: { type: "string" }, port: { type: "string", default: "8787" }, fresh: { type: "boolean", default: false } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0) throw new Error(`--port takes a number, not ${values.port}`);

const run = (cmd: string, args: string[]) => {
  const done = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
};
const bin = (name: string) => path.join(root, "node_modules/.bin", name);
run(bin("vite"), ["build", "web", "--outDir", "../dist", "--emptyOutDir", "--logLevel", "warn"]);
run("node", ["--import", "tsx", "scripts/write-seed.ts", ...(values.scenario ? ["--scenario", values.scenario] : [])]);

const vars = { DEV_USER: "dev@localhost", SEED: "1", DATA_FIXTURES: "1", LEVERS: "1" };
const wrangler = spawn(
  bin("wrangler"),
  [
    "dev",
    "-c",
    "worker/wrangler.jsonc",
    "--port",
    String(port),
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ...(values.scenario ? ["--persist-to", `.wrangler/scenarios/${values.scenario}`] : []),
  ],
  { cwd: root, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => wrangler.kill(signal));
wrangler.on("exit", (code) => process.exit(code ?? 0));

const base = `http://localhost:${port}`;
for (let i = 0; i < 120; i++) {
  const up = await fetch(`${base}/api/levers`).then((r) => r.ok, () => false);
  if (up) {
    if (values.fresh) await fetch(`${base}/api/levers/reset`, { method: "POST", body: JSON.stringify(values.scenario ? { scenario: values.scenario } : {}) });
    console.log(`\nCommon Ink is at ${base}/ (scenario ${values.scenario ?? "preview"}${values.fresh ? ", fresh" : ""}). docs/TESTING.md has the levers.\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
