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
