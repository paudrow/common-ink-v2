// What an extension's view or embed that throws does to the app: says so where it would have drawn, and
// leaves the rest working, whether it runs in the page or in the sandbox.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const MANIFEST = {
  name: "Broken",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [{ command: "broken.show", title: "Show the broken view" }],
    views: { sidebar: [{ id: "broken.view", name: "Broken view" }] },
    embeds: [{ language: "broken", title: "Broken" }],
  },
};

async function install(app: App, code: string, trusted: boolean) {
  await app.writeFile(".common-ink/extensions/broken/extension.json", JSON.stringify(MANIFEST));
  await app.writeFile(".common-ink/extensions/broken/index.js", code);
  if (trusted) await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "extensions.trusted": ["broken"] }));
  await app.writeFile("Broken.md", "# Broken\n\n```broken\n```\n\nThe note still works.\n");
  await app.reload();
}

async function stillWorks(app: App) {
  await app.open("Broken");
  await app.page.locator(".cm-embed .draw-error", { hasText: /Broken's broken embed couldn't be drawn: embed went wrong/ }).waitFor();
  await app.command("Show the broken view");
  await app.page.locator("#panel .draw-error", { hasText: /couldn't be drawn: view went wrong/ }).waitFor();
  await app.editor.focus();
  await app.keys("Gotyped<Esc>");
  await app.idle();
  assert.match(await app.readFile("Broken.md"), /works\.\n\ntyped$/, "the note still edits and saves");
  assert.equal((await app.extensions.state("broken"))?.error, "view went wrong");
}

browserTest(h, "a trusted extension whose view and embed throw shows what went wrong in their place, and the rest of the app works", { scenario: "empty", allowErrors: [/went wrong/] }, async (app) => {
  await install(app, 'export default { activate(ctx) { ctx.views.register("broken.view", { render() { throw new Error("view went wrong"); } }); ctx.embeds.register("broken", { render() { throw new Error("embed went wrong"); } }); ctx.commands.register("broken.show", () => ctx.views.show("broken.view")); } };', true);
  await stillWorks(app);
});

browserTest(h, "a sandboxed extension whose view and embed throw says so too", { scenario: "empty", allowErrors: [/went wrong/] }, async (app) => {
  await install(
    app,
    'export default { activate(ctx) { ctx.views.register("broken.view", { resolve() { throw new Error("view went wrong"); } }); ctx.embeds.register("broken", { resolve() { throw new Error("embed went wrong"); } }); ctx.commands.register("broken.show", () => ctx.views.show("broken.view")); } };',
    false,
  );
  await stillWorks(app);
});
