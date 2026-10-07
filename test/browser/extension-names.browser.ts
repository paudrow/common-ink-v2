// Extensions in the page that declare the same name: a built-in keeps its own, one you've turned off
// holds nothing, and between two trusted ones the first listed keeps it. The one that loses a name says
// so in the Extensions view, and the rest of it runs.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const HELPER = {
  name: "Helper",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "lists.toBullets", title: "Helper bullets" }, { command: "helper.go", title: "Run helper" }] },
};
const HELPER_CODE = `export default { activate(ctx) {
  ctx.commands.register("lists.toBullets", () => console.log("HELPER BULLETS"));
  ctx.commands.register("helper.go", () => ctx.workbench.notice("HELPER RAN"));
} };`;

const record = async (app: App, id: string) => (await app.state()).extensions.find((e: { id: string }) => e.id === id) as { state: string; error?: string } | undefined;

async function lists(app: App) {
  await app.writeFile("Plan.md", "# Plan\n\n- one\n- two\n");
  await app.reload();
  await app.open("Plan");
  await app.editor.focus();
  await app.editor.at(4);
  await app.page.keyboard.press("Alt+ArrowRight");
  assert.equal((await app.editor.cursor())?.text, "  - two", "Lists still indents");
  const r = await record(app, "lists");
  assert.equal(r?.error, undefined, `Lists: ${JSON.stringify(r)}`);
}

browserTest(h, "a trusted extension declaring one of Lists' command ids leaves Lists whole, says so, and runs the rest of itself", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["helper"]\n}\n');
  await app.writeFile(".common-ink/extensions/helper/extension.json", JSON.stringify(HELPER));
  await app.writeFile(".common-ink/extensions/helper/index.js", HELPER_CODE);
  await lists(app);
  assert.equal((await record(app, "helper"))?.error, `The command "lists.toBullets" is Lists's, so Helper's is left out`);
  await app.command("helper.go");
  await app.page.locator(".notice p", { hasText: "HELPER RAN" }).waitFor();
});

browserTest(h, "a trusted extension that's turned off, declaring one of Lists' command ids, leaves Lists whole", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["helper"],\n  "extensions.disabled": ["helper"]\n}\n');
  await app.writeFile(".common-ink/extensions/helper/extension.json", JSON.stringify(HELPER));
  await app.writeFile(".common-ink/extensions/helper/index.js", HELPER_CODE);
  await lists(app);
});

const twin = (name: string) => ({
  name,
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "shared.go", title: `${name}: go` }, { command: `${name.toLowerCase()}.own`, title: `${name}: own` }] },
});
const twinCode = (name: string) => `export default { activate(ctx) {
  ctx.commands.register("shared.go", () => ctx.workbench.notice("${name.toUpperCase()} SHARED"));
  ctx.commands.register("${name.toLowerCase()}.own", () => ctx.workbench.notice("${name.toUpperCase()} OWN"));
} };`;

browserTest(h, "between two trusted extensions declaring the same command, the first listed keeps it, and the other says so and runs the rest", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["alpha", "beta"]\n}\n');
  for (const name of ["Alpha", "Beta"]) {
    await app.writeFile(`.common-ink/extensions/${name.toLowerCase()}/extension.json`, JSON.stringify(twin(name)));
    await app.writeFile(`.common-ink/extensions/${name.toLowerCase()}/index.js`, twinCode(name));
  }
  await app.reload();
  await app.page.waitForTimeout(1000);
  assert.deepEqual([await record(app, "alpha"), await record(app, "beta")].map((r) => [r?.state, r?.error]), [
    ["active", undefined],
    ["active", `The command "shared.go" is Alpha's, so Beta's is left out`],
  ]);
  await app.command("shared.go");
  await app.page.locator(".notice p", { hasText: "ALPHA SHARED" }).waitFor();
  await app.command("beta.own");
  await app.page.locator(".notice p", { hasText: "BETA OWN" }).waitFor();
  assert.equal(await app.page.locator(".notice p", { hasText: "BETA SHARED" }).count(), 0);
});
