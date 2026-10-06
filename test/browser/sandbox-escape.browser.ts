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

const DRIVER = {
  name: "Driver",
  activationEvents: ["onCommand:driver.run", "onCommand:driver.own"],
  contributes: {
    commands: [
      { command: "driver.run", title: "Run Driver" },
      { command: "driver.own", title: "Driver's own" },
    ],
  },
};

const DRIVE = `export default { activate(ctx) {
  let ownRan = false;
  ctx.commands.register("driver.own", () => { ownRan = true; });
  ctx.commands.register("driver.run", async () => {
    const r = {};
    const t = async (k, f) => { try { await f(); r[k] = "done"; } catch (e) { r[k] = "refused"; } };
    await t("open settings", () => ctx.workbench.open(".common-ink/settings.json"));
    await t("split to settings", () => ctx.workbench.split("right", ".common-ink/users/tester@localhost/settings.json"));
    await t("open a note", () => ctx.workbench.open("Plan.md"));
    for (const c of ["lists.toBullets", "note.save", "account.signOut"]) await t(c, () => ctx.commands.run(c));
    await t("its own command", () => ctx.commands.run("driver.own"));
    r.ownRan = ownRan;
    await ctx.workbench.notice("DRIVER " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension runs only its own commands, and opens no settings or extension files", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/settings.json", '{\n  "extensions.trusted": []\n}\n');
  await app.writeFile("Plan.md", "# Plan\n");
  await app.writeFile(".common-ink/extensions/driver/extension.json", JSON.stringify(DRIVER));
  await app.writeFile(".common-ink/extensions/driver/index.js", DRIVE);
  await app.reload();
  const before = await app.readFile(".common-ink/settings.json");
  await app.command("Run Driver");
  const said = (await app.page.locator(".notice p", { hasText: "DRIVER" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), {
    "open settings": "refused",
    "split to settings": "refused",
    "open a note": "done",
    "lists.toBullets": "refused",
    "note.save": "refused",
    "account.signOut": "refused",
    "its own command": "done",
    ownRan: true,
  });
  assert.equal(await app.readFile(".common-ink/settings.json"), before);
});

const SQUATTER = {
  name: "Squatter",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { command: "squatter.go", title: "Squatter go" },
      { command: "lists.indent", title: "Indent" },
      { command: "tab.next", title: "Next tab" },
    ],
    keybindings: [
      { key: "Mod-s", command: "squatter.go" },
      { key: "Mod-Alt-j", command: "squatter.go" },
      { key: "Mod-Alt-k", command: "lists.indent" },
    ],
    statusBarItems: [{ id: "squatter", alignment: "left", priority: 1000, command: "settings.workspaceJson" }],
    menus: { commandBar: [{ command: "account.signOut" }] },
  },
};

const SQUAT = `export default { activate(ctx) {
  let went = 0;
  const r = {};
  const t = async (k, f) => { try { await f(); r[k] = "done"; } catch (e) { r[k] = "refused"; } };
  ctx.commands.register("squatter.go", async () => {
    went++;
    await t("run lists.indent", () => ctx.commands.run("lists.indent"));
    await t("run tab.next", () => ctx.commands.run("tab.next"));
    await t("open the Extensions view", () => ctx.views.open("extensions"));
    await t("show the Extensions view", () => ctx.views.show("extensions"));
    await ctx.workbench.notice("SQUAT " + went + " " + JSON.stringify(r));
  });
  ctx.statusBar.set("squatter", "Words: 12");
  void t("register lists.indent", () => ctx.commands.register("lists.indent", () => {}));
} };`;

browserTest(h, "a sandboxed extension can't take an app command's id, an app key, or point its status item and menus at app commands", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/settings.json", '{\n  "extensions.trusted": []\n}\n');
  await app.writeFile("Plan.md", "# Plan\n\n- one\n- two\n");
  await app.writeFile(".common-ink/extensions/squatter/extension.json", JSON.stringify(SQUATTER));
  await app.writeFile(".common-ink/extensions/squatter/index.js", SQUAT);
  await app.reload();
  await app.open("Plan");
  await app.keys("G");
  // Its key that the app doesn't use is its own; the app's save key stays the app's.
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+j" : "Control+Alt+j");
  const said = (await app.page.locator(".notice p", { hasText: "SQUAT 1" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), {
    "register lists.indent": "refused",
    "run lists.indent": "refused",
    "run tab.next": "refused",
    "open the Extensions view": "refused",
    "show the Extensions view": "refused",
  });
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+k" : "Control+Alt+k");
  await app.page.waitForTimeout(800);
  assert.equal(await app.page.locator(".notice p", { hasText: "SQUAT 2" }).count(), 0, "Mod-s still saves");
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\n- one\n- two\n", "lists.indent never ran for it");
  // Its status item shows its words, but a click runs nothing of the app's.
  await app.page.locator(".status-item", { hasText: "Words: 12" }).click();
  await app.page.waitForTimeout(500);
  assert.notEqual(await app.page.evaluate(() => (window as unknown as { __commonInk: { where(): { path?: string } | null } }).__commonInk.where()?.path), ".common-ink/settings.json");
});
