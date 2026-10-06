import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { freePort, isOurs, portTaken } from "../scripts/dev-port.ts";

/** A server that isn't this run's: it answers every request, as another worktree's Worker does. */
async function someoneElses(body = "{}") {
  const server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(body));
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  return { server, port: (server.address() as AddressInfo).port };
}

test("a port another server answers on is taken, and one nobody answers on isn't", async () => {
  const { server, port } = await someoneElses();
  assert.equal(await portTaken(port), true);
  await new Promise((r) => server.close(r));
  assert.equal(await portTaken(port), false);
  assert.equal(await portTaken(await freePort()), false);
});

test("a server is this run's only if it serves this run's nonce", async () => {
  const other = await someoneElses(JSON.stringify({ nonce: "theirs" }));
  assert.equal(await isOurs(`http://localhost:${other.port}`, "mine"), false);
  const mine = await someoneElses(JSON.stringify({ nonce: "mine" }));
  assert.equal(await isOurs(`http://localhost:${mine.port}`, "mine"), true);
  assert.equal(await isOurs(`http://localhost:${await freePort()}`, "mine"), false, "nothing there");
  await Promise.all([other, mine].map(({ server }) => new Promise((r) => server.close(r))));
});

test("npm run dev refuses a port another server answers on, says so, and sends that server nothing", async () => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  let asked = 0;
  const other = createServer((_req, res) => {
    asked++;
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => other.listen(0, "localhost", r));
  const port = (other.address() as AddressInfo).port;
  const dev = spawn(process.execPath, ["--import", "tsx", "scripts/dev.ts", "--port", String(port), "--fresh"], { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  dev.stderr.on("data", (d) => (said += d));
  const code = await new Promise<number | null>((r) => dev.on("exit", r));
  await new Promise((r) => other.close(r));
  assert.deepEqual([code, asked], [1, 0]);
  assert.match(said, new RegExp(`Port ${port} already has a server on it`));
});

test("a server is this run's only if it answers this run's nonce, which comes from the run, not the build", async () => {
  const levers = (run: string) => createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run })));
  const mine = levers("mine");
  await new Promise<void>((r) => mine.listen(0, "localhost", r));
  assert.equal(await isOurs(`http://localhost:${(mine.address() as AddressInfo).port}`, "mine"), true);
  assert.equal(await isOurs(`http://localhost:${(mine.address() as AddressInfo).port}`, "theirs"), false);
  await new Promise((r) => mine.close(r));
});
