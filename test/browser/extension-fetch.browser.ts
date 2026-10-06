// What the page sends the Worker for a sandboxed extension's net.fetch: the extension and the address
// are the app's to name, and of the options only the method, headers and body go along.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const PINGER = {
  name: "Pinger",
  activationEvents: ["onCommand:pinger.run"],
  permissions: { network: { hosts: ["example.com"], why: "Ping example.com" } },
  contributes: { commands: [{ command: "pinger.run", title: "Run Pinger" }] },
};

const PING = `export default { activate(ctx) {
  ctx.commands.register("pinger.run", async () => {
    await ctx.net.fetch("https://example.com/", { method: "POST", headers: { "X-Note": "1" }, body: "hi", extension: "link-embeds", url: "https://elsewhere.example/", once: true, card: true });
    await ctx.workbench.notice("PINGED");
  });
} };`;

browserTest(h, "a sandboxed extension's fetch goes out under its own name, to the address it asked for, with only a method, headers and body", { scenario: "empty", levers: { permissions: "allow" } }, async (app) => {
  await app.writeFile(".common-ink/extensions/pinger/extension.json", JSON.stringify(PINGER));
  await app.writeFile(".common-ink/extensions/pinger/index.js", PING);
  const sent: unknown[] = [];
  await app.page.route("**/api/extensions/fetch", async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({ json: { url: "https://example.com/", status: 200, headers: {}, body: "", truncated: false } });
  });
  await app.reload();
  await app.command("Run Pinger");
  await app.page.locator(".notice p", { hasText: "PINGED" }).waitFor();
  assert.deepEqual(sent, [{ extension: "pinger", url: "https://example.com/", method: "POST", headers: { "X-Note": "1" }, body: "hi", once: true }]);
});
