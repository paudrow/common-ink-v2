// A sandboxed extension's names are its own: not the app's, a built-in's or a trusted extension's,
// whatever its folder is called, and not by spelling a key or a command bar prefix another way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserTest, harness } from "./harness.ts";
import { ExtensionsView, type App } from "./pages.ts";

const h = harness();

const notice = async (app: App, start: string) => {
  const said = (await app.page.locator(".notice p", { hasText: start }).textContent())!;
  return JSON.parse(said.slice(said.indexOf("{"))) as unknown;
};

const SETTINGS = {
  name: "Settings helper",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "settings.helper", title: "Run Settings helper" }, { command: "settings.workspaceJson", title: "Workspace settings" }] },
};

const SETTINGS_CODE = `export default { activate(ctx) {
  ctx.commands.register("settings.helper", () => ctx.commands.run("settings.workspaceJson"));
  void ctx.commands.run("settings.workspaceJson");
} };`;

const INDENT = {
  name: "Indenter",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "lists.indent.go", title: "Run Indenter" }, { command: "lists.indent", title: "Indent" }] },
};

const INDENT_CODE = `export default { activate(ctx) { void ctx.commands.run("lists.indent"); } };`;

const EXT = {
  name: "Extensions helper",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "extensions.helper", title: "Run Extensions helper" }], views: { sidebar: [{ id: "extensions", name: "Extensions" }] } },
};

const EXT_CODE = `export default { activate(ctx) {
  ctx.views.register("extensions", { resolve(w) { w.html = "<p>FAKE EXTENSIONS VIEW</p>"; } });
  void ctx.views.open("extensions");
} };`;

const reason = (id: string) => `"${id}" is a name the app or a built-in extension uses for its own commands and views, so an extension in a folder named that can't run sandboxed. Rename its folder`;

for (const device of ["laptop", "phone"] as const) {
  browserTest(h, `on a ${device}, a sandboxed extension in a folder named for the app's or a built-in's commands doesn't run, and the Extensions view says why`, { scenario: "empty", device, allowErrors: [/./] }, async (app) => {
    await app.writeFile(".common-ink/settings.json", '{\n  "extensions.trusted": []\n}\n');
    await app.writeFile("Plan.md", "# Plan\n\n- one\n- two\n");
    const folders: Array<[string, object, string]> = [
      ["settings", SETTINGS, SETTINGS_CODE],
      ["Settings", SETTINGS, SETTINGS_CODE],
      ["lists.indent", INDENT, INDENT_CODE],
      ["extensions", EXT, EXT_CODE],
      ["dataSources", EXT, EXT_CODE],
    ];
    for (const [id, manifest, code] of folders) {
      await app.writeFile(`.common-ink/extensions/${id}/extension.json`, JSON.stringify(manifest));
      await app.writeFile(`.common-ink/extensions/${id}/index.js`, code);
    }
    await app.reload();
    await app.open("Plan");
    await app.page.waitForTimeout(1500);
    const view = new ExtensionsView(app);
    for (const [id] of folders) assert.deepEqual(await view.state(id).then((s) => [s?.state, s?.error?.slice(0, reason(id).length)]), ["failed", reason(id)], id);
    await assert.rejects(app.command("Run Settings helper"), /No command/);
    await assert.rejects(app.command("Run Indenter"), /No command/);
    const where = await app.page.evaluate(() => (window as unknown as { __commonInk: { where(): { path?: string } | null } }).__commonInk.where()?.path);
    assert.equal(where, "Plan.md", "settings.json didn't open");
    assert.equal(await app.readFile("Plan.md"), "# Plan\n\n- one\n- two\n", "lists.indent never ran");
    await view.show();
    assert.equal(await app.page.getByText("FAKE EXTENSIONS VIEW").count(), 0);
    await view.row("lists.indent").click();
    await app.page.locator(".extension-error", { hasText: reason("lists.indent") }).waitFor();
  });
}

const TRUSTED = {
  name: "Word count (trusted)",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "wordCount.secret", title: "Count secretly" }], views: { sidebar: [{ id: "wordCount", name: "Counts" }] } },
};

const TRUSTED_CODE = `export default { activate(ctx) {
  ctx.commands.register("wordCount.secret", () => ctx.workbench.notice("TRUSTED {}"));
  ctx.views.register("wordCount", { render(el) { el.textContent = "TRUSTED VIEW"; } });
} };`;

const NEIGHBOUR = {
  name: "Word count (sandboxed)",
  activationEvents: ["onCommand:word-count.probe"],
  contributes: {
    commands: [
      { command: "word-count.probe", title: "Run probe" },
      { command: "wordCount.secret", title: "Count secretly too" },
    ],
    keybindings: [{ key: "Mod-Alt-u", command: "wordCount.secret" }],
    menus: { commandBar: [{ command: "wordCount.secret" }] },
    views: { sidebar: [{ id: "wordCount", name: "Counts too" }] },
  },
};

const NEIGHBOUR_CODE = `export default { activate(ctx) {
  ctx.commands.register("word-count.probe", async () => {
    const r = {};
    const t = async (k, f) => { try { await f(); r[k] = "done"; } catch (e) { r[k] = "refused"; } };
    await t("run its neighbour's command", () => ctx.commands.run("wordCount.secret"));
    await t("take its neighbour's command", () => ctx.commands.register("wordCount.secret", () => ctx.workbench.notice("STOLEN {}")));
    await t("open its neighbour's view", () => ctx.views.open("wordCount"));
    await t("draw its neighbour's view", () => ctx.views.register("wordCount", { resolve(w) { w.html = "<p>STOLEN VIEW</p>"; } }));
    await t("take the command bar's search", () => ctx.commandBar.provide({ prefix: "", placeholder: "", items: async () => [] }));
    await t("take the command bar's commands", () => ctx.commandBar.provide({ prefix: ">", placeholder: "", items: async () => [] }));
    await t("take another's prefix", () => ctx.commandBar.provide({ prefix: "event:", placeholder: "", items: async () => [] }));
    await t("take its own prefix", () => ctx.commandBar.provide({ prefix: "word-count ", placeholder: "", items: async () => [{ label: "OWN ROW", run() {} }] }));
    await ctx.workbench.notice("PROBE " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension can't run, take, open or bind what went in for a trusted extension under the same name, nor take the command bar's prefixes", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["wordCount"]\n}\n');
  await app.writeFile(".common-ink/extensions/wordCount/extension.json", JSON.stringify(TRUSTED));
  await app.writeFile(".common-ink/extensions/wordCount/index.js", TRUSTED_CODE);
  await app.writeFile(".common-ink/extensions/word-count/extension.json", JSON.stringify(NEIGHBOUR));
  await app.writeFile(".common-ink/extensions/word-count/index.js", NEIGHBOUR_CODE);
  await app.reload();
  await app.command("Run probe");
  assert.deepEqual(await notice(app, "PROBE"), {
    "run its neighbour's command": "refused",
    "take its neighbour's command": "refused",
    "open its neighbour's view": "refused",
    "draw its neighbour's view": "refused",
    "take the command bar's search": "refused",
    "take the command bar's commands": "refused",
    "take another's prefix": "refused",
    "take its own prefix": "done",
  });
  // Its key for the neighbour's command isn't bound.
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+u" : "Control+Alt+u");
  await app.page.waitForTimeout(800);
  assert.equal(await app.page.locator(".notice p", { hasText: "TRUSTED" }).count(), 0, "its neighbour's command didn't run for it");
  await app.command("wordCount.secret");
  await app.page.locator(".notice p", { hasText: "TRUSTED" }).waitFor();
  assert.equal(await app.page.locator(".notice p", { hasText: "STOLEN" }).count(), 0);
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  await app.page.locator("#command-bar input").fill("word-count ");
  await app.page.locator("#command-bar li", { hasText: "OWN ROW" }).waitFor();
});

const TAKER = {
  name: "Taker",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [{ command: "taker.go", title: "Take" }],
    keybindings: [
      { key: "Mod-Ctrl-s", command: "taker.go" },
      { key: "Ctrl-Mod-s", command: "taker.go" },
      { key: "Mod-Alt-j", command: "taker.go" },
    ],
  },
};

const TAKE = `export default { activate(ctx) {
  let n = 0;
  ctx.commands.register("taker.go", () => ctx.workbench.notice("TAKER " + ++n));
} };`;

browserTest(h, "off a Mac, a sandboxed extension's Mod-Ctrl-s is the app's Ctrl+S, which stays the app's", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  await app.writeFile(".common-ink/settings.json", '{\n  "extensions.trusted": []\n}\n');
  await app.writeFile("Plan.md", "# Plan\n");
  await app.writeFile(".common-ink/extensions/taker/extension.json", JSON.stringify(TAKER));
  await app.writeFile(".common-ink/extensions/taker/index.js", TAKE);
  await app.reload();
  await app.open("Plan");
  await app.page.waitForTimeout(1000);
  await app.page.keyboard.press("Control+Alt+j");
  await app.page.locator(".notice p", { hasText: "TAKER 1" }).waitFor();
  await app.page.keyboard.press("Control+s");
  await app.page.waitForTimeout(800);
  assert.equal(await app.page.locator(".notice p", { hasText: "TAKER 2" }).count(), 0, "Ctrl+S still saves");
});

const LATE = {
  name: "Levers helper",
  activationEvents: ["onCommand:leverage.helper"],
  contributes: { commands: [{ command: "leverage.helper", title: "Run Levers helper" }] },
};

browserTest(h, "a sandboxed extension in a folder named for the test levers, which go in after extensions, doesn't run", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/levers/extension.json", JSON.stringify({ ...LATE, contributes: { commands: [...LATE.contributes.commands, { command: "levers.reset", title: "Reset" }] } }));
  await app.writeFile(".common-ink/extensions/levers/index.js", "export default { activate() {} };");
  await app.writeFile("Keep me.md", "# Keep me\n");
  await app.reload();
  assert.equal((await new ExtensionsView(app).state("levers"))?.state, "failed");
  assert.equal(await app.readFile("Keep me.md"), "# Keep me\n");
});

const STATUS_TRUSTED = {
  name: "Word count",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "wordCount.secret", title: "Count secretly" }] },
};

const STATUS_NEIGHBOUR = {
  name: "Word count (sandboxed)",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "wordCount.secret", title: "Count secretly too" }], statusBarItems: [{ id: "bait", alignment: "left", priority: 1000, command: "wordCount.secret" }] },
};

browserTest(h, "a sandboxed extension's status item, clicked, runs nothing that isn't its own", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["wordCount"]\n}\n');
  await app.writeFile(".common-ink/extensions/wordCount/extension.json", JSON.stringify(STATUS_TRUSTED));
  await app.writeFile(".common-ink/extensions/wordCount/index.js", `export default { activate(ctx) { ctx.commands.register("wordCount.secret", () => ctx.workbench.notice("TRUSTED RAN")); } };`);
  await app.writeFile(".common-ink/extensions/word-count/extension.json", JSON.stringify(STATUS_NEIGHBOUR));
  await app.writeFile(".common-ink/extensions/word-count/index.js", `export default { activate(ctx) { ctx.statusBar.set("bait", "Words: 12"); } };`);
  await app.reload();
  await app.page.locator(".status-item", { hasText: "Words: 12" }).click();
  await app.page.waitForTimeout(1000);
  assert.equal(await app.page.locator(".notice p", { hasText: "TRUSTED RAN" }).count(), 0);
  await app.command("wordCount.secret");
  await app.page.locator(".notice p", { hasText: "TRUSTED RAN" }).waitFor();
});

const SECRET_BOX = { language: "secretbox", title: "Secret box", description: "", syntax: "fence", arguments: {}, body: "text" };

browserTest(h, "a sandboxed extension can't draw, or read, an embed a trusted extension draws", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["secretbox"]\n}\n');
  await app.writeFile(".common-ink/extensions/secretbox/extension.json", JSON.stringify({ name: "Secret box", activationEvents: ["onEmbed:secretbox"], contributes: { embeds: [SECRET_BOX] } }));
  await app.writeFile(".common-ink/extensions/secretbox/index.js", `export default { activate(ctx) { ctx.embeds.register("secretbox", { render(el) { el.textContent = "TRUSTED DRAW"; } }); } };`);
  await app.writeFile(".common-ink/extensions/thief/extension.json", JSON.stringify({ name: "Thief", activationEvents: ["onStartup"], contributes: { embeds: [SECRET_BOX] } }));
  await app.writeFile(
    ".common-ink/extensions/thief/index.js",
    // It asks to draw the embed after the trusted extension has, as it would if its frame started late.
    `export default { activate(ctx) { setTimeout(() => ctx.embeds.register("secretbox", { resolve(w, embed) { console.log("THIEF GOT " + JSON.stringify(embed.body)); w.html = "<p>THIEF</p>"; } }).then(() => console.log("THIEF REGISTERED"), () => console.log("THIEF REFUSED")), 2000); } };`,
  );
  await app.writeFile("Private.md", "# Private\n\n```secretbox\nkeep this to myself\n```\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.reload();
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.open("Private");
  await app.page.getByText("TRUSTED DRAW").waitFor();
  await app.page.waitForEvent("console", { predicate: (m) => m.text().startsWith("THIEF RE"), timeout: 10_000 });
  await app.open("Other");
  await app.open("Private");
  await app.page.getByText("TRUSTED DRAW").waitFor();
  await app.page.waitForTimeout(1000);
  assert.deepEqual(logs.filter((l) => l.startsWith("THIEF")), ["THIEF REFUSED"]);
});

browserTest(h, "a sandboxed extension can't take Vim's Ctrl-r (redo) from the editor", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(
    ".common-ink/extensions/redo-taker/extension.json",
    JSON.stringify({ name: "Redo taker", activationEvents: ["onStartup"], contributes: { commands: [{ command: "redo-taker.go", title: "Go" }], keybindings: ["Ctrl-r", "Ctrl-w", "Mod-o", "Mod-Shift-Alt-r"].map((key) => ({ key, command: "redo-taker.go" })) } }),
  );
  await app.writeFile(".common-ink/extensions/redo-taker/index.js", `export default { activate(ctx) { let n = 0; ctx.commands.register("redo-taker.go", () => ctx.workbench.notice("REDO TAKEN " + ++n)); } };`);
  await app.writeFile("Plan.md", "# Plan\n\none\ntwo\n");
  await app.reload();
  await app.open("Plan");
  await app.keys("G");
  await app.keys("dd");
  await app.keys("u");
  await app.page.keyboard.press("Control+r");
  await app.page.waitForTimeout(1000);
  assert.equal(await app.page.locator(".notice p", { hasText: "REDO TAKEN" }).count(), 0, "Ctrl-r is still Vim's redo");
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Alt+r" : "Control+Shift+Alt+r");
  await app.page.locator(".notice p", { hasText: "REDO TAKEN 1" }).waitFor();
});

for (const device of ["laptop", "phone"] as const) {
  browserTest(h, `on a ${device}, an untrusted customized copy of Lists waits for your trust, and the built-in keeps working meanwhile`, { scenario: "empty", device, allowErrors: [/./] }, async (app) => {
    const manifest = JSON.stringify({ ...JSON.parse(readFileSync("web/src/extensions/lists/extension.json", "utf8")), name: "Lists, customized", main: "index.js", files: ["index.js"] });
    await app.writeFile(".common-ink/extensions/lists/extension.json", manifest);
    await app.writeFile(".common-ink/extensions/lists/index.js", "export default { activate() {} };");
    await app.writeFile("Plan.md", "# Plan\n\n- one\n- two\n");
    await app.reload();
    const view = new ExtensionsView(app);
    assert.deepEqual(await view.state("lists").then((s) => [s?.state, s?.name]), ["active", "Lists"], "the built-in runs, under its own name");
    if (device === "laptop") {
      await app.open("Plan");
      await app.editor.focus();
      await app.editor.at(4);
      await app.page.keyboard.press("Alt+ArrowRight");
      assert.equal((await app.editor.cursor())?.text, "  - two", "the built-in's Alt-Right indents");
    }
    await view.show();
    const row = view.row("lists");
    await row.getByText("Not running · trust it to use your customized copy").waitFor();
    await row.getByRole("button", { name: "Trust…" }).waitFor();
  });
}
