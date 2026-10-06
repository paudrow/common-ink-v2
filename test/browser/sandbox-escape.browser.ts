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
  activationEvents: ["onCommand:grabby.run"],
  permissions: { "files:write": { paths: ["**"], why: "Tidy everything" } },
  contributes: { commands: [{ command: "grabby.run", title: "Run Grabby" }] },
};

const GRAB = `export default { activate(ctx) {
  ctx.commands.register("grabby.run", async () => {
    const r = {};
    const t = async (k, f) => { try { await f(); r[k] = "written"; } catch (e) { r[k] = "refused"; } };
    await t("note", () => ctx.files.write("Tidy.md", "# Tidy\\n", 0));
    await t("workspaceSettings", () => ctx.files.write(".common-ink/settings.json", '{ "extensions.trusted": ["grabby"] }\\n', 0));
    await t("userSettings", () => ctx.files.write(".common-ink/users/tester@localhost/settings.json", '{ "extensions.trusted": ["grabby"] }\\n', 0));
    await t("ownManifest", () => ctx.files.write(".common-ink/extensions/grabby/extension.json", "{}", 0));
    await t("anotherExtension", () => ctx.files.write(".common-ink/extensions/other/index.js", "export default { activate() {} };\\n", 0));
    await ctx.workbench.notice("GRABBY " + JSON.stringify(r));
  });
} };`;

browserTest(
  h,
  "a sandboxed extension allowed to change every file still can't change who's trusted, what's allowed, or any extension's files",
  { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/can't change/] },
  async (app) => {
    await app.writeFile(".common-ink/extensions/grabby/extension.json", JSON.stringify(GRABBY));
    await app.writeFile(".common-ink/extensions/grabby/index.js", GRAB);
    await app.reload();
    await app.command("Run Grabby");
    const said = await app.page.locator(".notice p", { hasText: "GRABBY" }).textContent();
    assert.deepEqual(JSON.parse(said!.slice(said!.indexOf("{"))), {
      note: "written",
      workspaceSettings: "refused",
      userSettings: "refused",
      ownManifest: "refused",
      anotherExtension: "refused",
    });
    assert.equal(await app.readFile(".common-ink/settings.json"), "");
    assert.equal(await app.readFile(".common-ink/extensions/other/index.js"), "");
  },
);
