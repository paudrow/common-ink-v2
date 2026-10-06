// The app on this machine: the Worker, its Durable Object and the web app, signed in as a dev user, with
// test levers on and the workspace seeded from a scenario (docs/TESTING.md).
//
//   npm run dev -- [--scenario lists] [--port 8787] [--fresh] [--fake-google]
//
// --port 0 picks a free port. A port something already answers on is refused, since that's another
// server, perhaps another worktree's, and only a server this run started is ever reset.
//
// Each scenario keeps its own workspace on disk (.wrangler/scenarios/<name>), so switching between them
// keeps what you did in each; without --scenario it's the Preview's notes, kept where they always were.
// --fresh resets the workspace to its scenario once the server is up. --fake-google puts a fake Google
// Calendar (worker/src/fake-google.ts) in place of the Sample calendar, connected, so sync, conflicts
// and reconnecting can be tried: POST /api/levers/google {"revoked": true} ends its grant.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { freePort, isOurs, portTaken, RUN_FILE } from "./dev-port.ts";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { scenario: { type: "string" }, port: { type: "string", default: "8787" }, fresh: { type: "boolean", default: false }, "fake-google": { type: "boolean", default: false } },
});
const asked = Number(values.port);
if (!Number.isInteger(asked) || asked < 0) throw new Error(`--port takes a number, or 0 for a free one, not ${values.port}`);
const port = asked || (await freePort());
if (await portTaken(port)) {
  console.error(`Port ${port} already has a server on it, perhaps another worktree's. Stop yours by its process, or pick another port (--port 0 picks a free one).`);
  process.exit(1);
}

const run = (cmd: string, args: string[]) => {
  const done = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
};
const bin = (name: string) => path.join(root, "node_modules/.bin", name);
run(bin("vite"), ["build", "web", "--outDir", "../dist", "--emptyOutDir", "--logLevel", "warn"]);
run("node", ["--import", "tsx", "scripts/write-seed.ts", ...(values.scenario ? ["--scenario", values.scenario] : [])]);
const nonce = randomUUID();
writeFileSync(path.join(root, "dist", RUN_FILE), JSON.stringify({ nonce }));

const vars: Record<string, string> = values["fake-google"] ? { DEV_USER: "dev@localhost", SEED: "1", FAKE_GOOGLE: "1", LEVERS: "1" } : { DEV_USER: "dev@localhost", SEED: "1", DATA_FIXTURES: "1", LEVERS: "1" };
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
  if (await isOurs(base, nonce)) {
    if (values.fresh) await fetch(`${base}/api/levers/reset`, { method: "POST", body: JSON.stringify(values.scenario ? { scenario: values.scenario } : {}) });
    console.log(`\nCommon Ink is at ${base}/ (scenario ${values.scenario ?? "preview"}${values.fresh ? ", fresh" : ""}). docs/TESTING.md has the levers.\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
