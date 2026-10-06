// Requests from another site, against the real Worker where the dev user is signed in without a cookie
// (as on this machine): nothing that changes the workspace or listens to it is answered. The CLI and
// agents send no Origin, and the app's own page sends its own.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness();
const EVIL = "https://evil.example";

const put = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${h.base}/api/file`, { method: "PUT", headers: { "Content-Type": "text/plain", ...headers }, body: JSON.stringify({ path, text: "# Written\n", base: 0 }) });
const exists = async (path: string) => (await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`)).status === 200;

test("another site's request can't change the workspace, even with the dev user signed in by address", async () => {
  assert.equal((await put("From elsewhere.md", { Origin: EVIL })).status, 403);
  assert.equal((await put("From a sandbox.md", { Origin: "null" })).status, 403);
  const install = await fetch(`${h.base}/api/extensions/install`, { method: "POST", headers: { Origin: EVIL, "Content-Type": "text/plain" }, body: JSON.stringify({ url: "https://evil.example/ext/" }) });
  assert.equal(install.status, 403);
  const mcp = await fetch(`${h.base}/mcp`, { method: "POST", headers: { Origin: EVIL, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", arguments: { path: "Welcome.md", base: 1 } } }) });
  assert.equal(mcp.status, 403);
  assert.deepEqual([await exists("From elsewhere.md"), await exists("From a sandbox.md")], [false, false]);
  assert.equal((await put("From the app.md", { Origin: h.base })).status, 200);
  assert.equal((await put("From the CLI.md")).status, 200);
  assert.deepEqual([await exists("From the app.md"), await exists("From the CLI.md")], [true, true]);
});

/** Whether a live socket opens, sent with this Origin. */
function opens(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${h.base.replace(/^http/, "ws")}/api/live`, { headers: { Origin: origin } } as unknown as string[]);
    ws.onopen = () => (ws.close(), resolve(true));
    ws.onerror = () => resolve(false);
  });
}

test("another site can't open the live socket that hears of every change", async () => {
  assert.equal(await opens(EVIL), false);
  assert.equal(await opens(h.base), true);
});

test("a page on another site, in a real browser, can't write through MCP with a no-cors POST, which the app's own page can", async () => {
  const elsewhere = createServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>elsewhere</title>"));
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  const context = await h.browser.newContext();
  try {
    const page = await context.newPage();
    const answers: number[] = [];
    page.on("response", (r) => r.url() === `${h.base}/mcp` && answers.push(r.status()));
    const write = (path: string) =>
      page.evaluate(
        async ({ base, path }) => {
          const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path, text: "x", base: 0 } } };
          await fetch(`${base}/mcp`, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(call) });
        },
        { base: h.base, path },
      );
    await page.goto(`http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/`);
    await write("From a page elsewhere.md");
    // The same request from the app's own page goes through: the refusal above is the Worker's, not the browser's.
    await page.goto(`${h.base}/schema/settings.json`);
    await write("From the app's page.md");
    assert.deepEqual(answers, [403, 200], "it reached the Worker both times");
    assert.deepEqual([await exists("From a page elsewhere.md"), await exists("From the app's page.md")], [false, true]);
  } finally {
    await context.close();
    elsewhere.close();
  }
});
