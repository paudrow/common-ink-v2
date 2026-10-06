// Stop trusting, wherever the trust was given: your settings or the workspace's.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import { ExtensionsView } from "./pages.ts";

const h = harness();

browserTest(h, "Stop trusting takes the extension out of the workspace's trusted list as well as yours", { scenario: "empty", levers: { permissions: "allow" } }, async (app) => {
  await app.writeFile(".common-ink/extensions/gadget/extension.json", JSON.stringify({ name: "Gadget" }));
  await app.writeFile(".common-ink/extensions/gadget/index.js", "export default { activate() {} };\n");
  await app.writeFile(".common-ink/settings.json", '{\n  "extensions.trusted": ["gadget", "other"]\n}\n');
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["gadget"]\n}\n');
  await app.reload();
  const view = new ExtensionsView(app);
  await view.show();
  await view.row("gadget").click();
  await app.page.getByRole("button", { name: "Stop trusting" }).click();
  await app.page.getByRole("button", { name: "Trust…" }).waitFor();
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/settings.json"))["extensions.trusted"], ["other"]);
  assert.deepEqual(JSON.parse(await app.readFile(".common-ink/users/tester@localhost/settings.json"))["extensions.trusted"], []);
});

browserTest(h, "reinstalling an extension you trusted says its trust was taken back, even when it starts after a reload", { scenario: "empty", levers: { permissions: "allow", net: "replay" } }, async (app) => {
  await app.writeFile(".common-ink/extensions/gadget/extension.json", JSON.stringify({ name: "Gadget" }));
  await app.writeFile(".common-ink/extensions/gadget/index.js", "export default { activate() {} };\n");
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["gadget"]\n}\n');
  await app.reload();
  const view = new ExtensionsView(app);
  await view.show();
  await app.page.getByRole("button", { name: "Install from URL…" }).click();
  await app.page.getByRole("textbox", { name: "Install an extension from a URL" }).fill("https://ext.example/gadget/");
  await app.page.keyboard.press("Enter");
  const notice = app.page.locator(".notice p", { hasText: "Installed Gadget" });
  await notice.waitFor();
  assert.match((await notice.textContent())!, /^Installed Gadget\. It starts after a reload: trust given to an earlier Gadget was taken back, for everyone\./);
});
