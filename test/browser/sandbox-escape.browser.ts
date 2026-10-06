// Ways out of the sandbox that don't go through its frame's own limits (ADR 0006): its shells loaded
// somewhere other than the app's sandboxed frames, and a sandboxed extension writing the files that
// decide what runs in the page and what extensions may do.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { browserTest, harness } from "./harness.ts";

const h = harness();

test("the sandbox's shells are sandboxed by their own policy wherever they load, and only the app may frame them", async () => {
  const context = await h.browser.newContext();
  const page = await context.newPage();
  for (const shell of ["host", "webview"]) {
    await page.goto(`${h.base}/sandbox/${shell}`);
    assert.equal(await page.evaluate(() => window.origin), "null", `${shell}, opened by itself`);
  }
  // Another origin (a page on another port) frames the webview shell, as it would to hand it HTML.
  const framing = createServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(`<iframe src="${h.base}/sandbox/webview"></iframe><iframe src="${h.base}/sandbox/vendor/three/three.module.js"></iframe>`));
  await new Promise<void>((resolve) => framing.listen(0, "127.0.0.1", resolve));
  await page.goto(`http://127.0.0.1:${(framing.address() as AddressInfo).port}/`);
  await page.waitForTimeout(1000);
  const frames = page.frames().slice(1).map((f) => f.url());
  framing.close();
  assert.ok(frames.includes(`${h.base}/sandbox/vendor/three/three.module.js`), `a frame from the app's address can load there: ${frames}`);
  assert.ok(!frames.includes(`${h.base}/sandbox/webview`), `the webview shell didn't: ${frames}`);
  await context.close();
});

const GRABBY = {
  name: "Grabby",
  activationEvents: ["onCommand:grabby.run", "onCommand:grabby.where"],
  permissions: { "files:write": { paths: ["**"], why: "Tidy everything" } },
  contributes: {
    commands: [
      { command: "grabby.run", title: "Run Grabby" },
      { command: "grabby.where", title: "Where is Grabby" },
    ],
  },
};

// Each file, as a string, a String object and an array: the frame's messages are structured clones,
// which keep both, and either reads as the path once something turns it into a string.
const GRAB = `export default { activate(ctx) {
  const trust = '{ "extensions.trusted": ["grabby"] }\\n';
  ctx.commands.register("grabby.run", async () => {
    const r = {};
    const t = async (k, p, text) => {
      for (const [how, path] of [["plain", p], ["boxed", new String(p)], ["array", [p]]]) {
        try { await ctx.files.write(path, text, 0); r[k + " " + how] = "written"; } catch (e) { r[k + " " + how] = "refused"; }
      }
    };
    await t("note", "Tidy.md", "# Tidy\\n");
    await t("workspaceSettings", ".common-ink/settings.json", trust);
    await t("userSettings", ".common-ink/users/" + ctx.me + "/settings.json", trust);
    await t("ownManifest", ".common-ink/extensions/grabby/extension.json", "{}");
    await t("anotherExtension", ".common-ink/extensions/other/index.js", "export default { activate() {} };\\n");
    await ctx.workbench.notice("GRABBY " + JSON.stringify(r));
  });
  ctx.commands.register("grabby.where", () => ctx.workbench.notice("WHERE " + self.origin));
} };`;

browserTest(
  h,
  "a sandboxed extension allowed to change every file still can't change who's trusted, what's allowed, or any extension's files, however it passes the path",
  { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/can't change|isn't a file path/] },
  async (app) => {
    await app.writeFile(".common-ink/extensions/grabby/extension.json", JSON.stringify(GRABBY));
    await app.writeFile(".common-ink/extensions/grabby/index.js", GRAB);
    await app.reload();
    await app.command("Run Grabby");
    const said = await app.page.locator(".notice p", { hasText: "GRABBY" }).textContent();
    const written = Object.entries(JSON.parse(said!.slice(said!.indexOf("{")))).filter(([, how]) => how === "written").map(([what]) => what);
    assert.deepEqual(written, ["note plain"]);
    assert.equal(await app.readFile(".common-ink/settings.json"), "");
    assert.equal(await app.readFile(".common-ink/users/tester@localhost/settings.json"), "");
    assert.equal(await app.readFile(".common-ink/extensions/other/index.js"), "");
    await app.reload();
    await app.command("Where is Grabby");
    assert.equal(await app.page.locator(".notice p", { hasText: "WHERE" }).textContent(), "Grabby: WHERE null", "still sandboxed after a reload");
  },
);

test("the Worker refuses an untrusted extension's change to the files that decide trust, but not its own state", async () => {
  const write = async (path: string, extension: string) => {
    const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
    const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
    return fetch(`${h.base}/api/file`, { method: "PUT", headers: { "X-Common-Ink-Extension": extension }, body: JSON.stringify({ path, text: "{}\n", base }) });
  };
  assert.equal((await write(".common-ink/settings.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/users/tester@localhost/settings.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/other/index.js", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/grabby/installed.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/grabby/state.json", "grabby")).status, 200);
  assert.equal((await write("Grabby was here.md", "grabby")).status, 200);
});

test("the Worker's gate covers undo, and an extension name it couldn't have", async () => {
  const put = async (path: string, text: string, headers: Record<string, string> = {}) => {
    const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
    const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
    return fetch(`${h.base}/api/file`, { method: "PUT", headers, body: JSON.stringify({ path, text, base }) });
  };
  const change = (await (await put(".common-ink/settings.json", '{ "extensions.trusted": [] }\n')).json()) as { file: { revision: number } };
  const undo = await fetch(`${h.base}/api/undo`, { method: "POST", headers: { "X-Common-Ink-Extension": "grabby" }, body: JSON.stringify({ revisions: [change.file.revision] }) });
  assert.equal(undo.status, 403);
  assert.equal((await put(".common-ink/extensions/grabby/sub/state.json", "{}\n", { "X-Common-Ink-Extension": "grabby/sub" })).status, 400);
  assert.equal((await put(".common-ink/settings.json", "{}\n", { "X-Common-Ink-Extension": "" })).status, 400);
});

const BIG = {
  name: "Biggy",
  activationEvents: ["onCommand:biggy.run"],
  permissions: { "files:write": { paths: ["**"], why: "Write a lot" } },
  contributes: { commands: [{ command: "biggy.run", title: "Run Biggy" }] },
};

const BIGGY = `export default { activate(ctx) {
  ctx.commands.register("biggy.run", async () => {
    const r = [];
    for (const [path, text] of [["Big.md", "x".repeat(3000000)], [".common-ink/extensions/biggy/state.json", "{}"]]) {
      try { await ctx.files.write(path, text, 0); r.push("written"); } catch (e) { r.push(e.message); }
    }
    await ctx.workbench.notice("BIGGY " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension's call is refused past a size, and writing its own state as a file points at ctx.state", { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/biggy/extension.json", JSON.stringify(BIG));
  await app.writeFile(".common-ink/extensions/biggy/index.js", BIGGY);
  await app.reload();
  await app.command("Run Biggy");
  const said = (await app.page.locator(".notice p", { hasText: "BIGGY" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("["))), [
    "Biggy sent more than 2 MB in one call",
    "Biggy can't change its own state.json as a file: use ctx.state",
  ]);
  assert.equal(await app.readFile("Big.md"), "");
});
