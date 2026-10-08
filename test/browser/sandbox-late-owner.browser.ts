// What a sandboxed extension registered stays its own, and only its own: an id or embed language a
// trusted extension declares runs and draws that extension's code, and a customized built-in you don't
// trust runs as it shipped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const SHADOW = {
  name: "Sneaky",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { command: "vim.onHere", title: "Vim: turn on for this device" },
      { command: "note.save", title: "Save" },
      { command: "account.signOut", title: "Sign out" },
      { command: "device.keyboardYes", title: "Keyboard: yes" },
    ],
  },
};
const SHADOW_CODE = `export default { async activate(ctx) {
  const r = {};
  for (const id of ["vim.onHere", "note.save", "account.signOut", "device.keyboardYes"]) {
    try { await ctx.commands.register(id, () => console.log("SANDBOX HANDLER RAN " + id)); r[id] = "registered"; } catch (e) { r[id] = "refused"; }
  }
  console.log("SHADOW " + JSON.stringify(r));
} };`;

browserTest(h, "a sandboxed manifest declaring core ids (vim.onHere, note.save, account.signOut, device.keyboardYes) replaces none of them", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.writeFile(".common-ink/extensions/sneaky/extension.json", JSON.stringify(SHADOW));
  await app.writeFile(".common-ink/extensions/sneaky/index.js", SHADOW_CODE);
  await app.writeFile("Plan.md", "# Plan\n");
  await app.reload();
  await app.page.waitForTimeout(2000);
  const shadow = logs.find((l) => l.startsWith("SHADOW "));
  assert.ok(shadow, "the extension started");
  assert.deepEqual(JSON.parse(shadow!.slice(7)), { "vim.onHere": "refused", "note.save": "refused", "account.signOut": "refused", "device.keyboardYes": "refused" });
  await app.open("Plan");
  for (const id of ["vim.onHere", "note.save", "device.keyboardYes"]) await app.call("command", id);
  await app.page.waitForTimeout(1500);
  assert.equal(logs.filter((l) => l.includes("SANDBOX HANDLER RAN")).length, 0, logs.filter((l) => l.includes("SANDBOX")).join("; "));
});

// The sandboxed extension sorts before the trusted one, so a first-declarer rule would give it the embed.
const OWNER = {
  name: "Secret box",
  activationEvents: ["onEmbed:secretbox"],
  contributes: { embeds: [{ language: "secretbox", title: "Secret box", description: "", syntax: "fence", arguments: {}, body: "text" }] },
};
const OWNER_CODE = `export default { activate(ctx) { ctx.embeds.register("secretbox", { render(el) { el.textContent = "TRUSTED DRAW"; } }); } };`;
const THIEF = {
  name: "Thief",
  activationEvents: ["onEmbed:secretbox"],
  contributes: { embeds: [{ language: "secretbox", title: "Secret box", description: "", syntax: "fence", arguments: {}, body: "text" }] },
};
const THIEF_CODE = `export default { async activate(ctx) {
  let r; try { await ctx.embeds.register("secretbox", { resolve(w, embed) { console.log("THIEF GOT " + JSON.stringify(embed.body)); w.html = "<p>THIEF</p>"; } }); r = "registered"; } catch (e) { r = "refused"; }
  console.log("THIEF REGISTER " + r);
} };`;

browserTest(h, "a sandboxed extension sorted before a trusted one can't draw, and read, its embed", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["secretbox"]\n}\n');
  await app.writeFile(".common-ink/extensions/secretbox/extension.json", JSON.stringify(OWNER));
  await app.writeFile(".common-ink/extensions/secretbox/index.js", OWNER_CODE);
  await app.writeFile(".common-ink/extensions/a-thief/extension.json", JSON.stringify(THIEF));
  await app.writeFile(".common-ink/extensions/a-thief/index.js", THIEF_CODE);
  await app.writeFile("Private.md", "# Private\n\n```secretbox\nkeep this to myself\n```\n");
  await app.reload();
  await app.open("Private");
  await app.page.waitForTimeout(4000);
  const stolen = logs.find((l) => l.includes("THIEF GOT"));
  assert.equal(stolen, undefined, `the sandboxed extension drew the trusted one's embed: ${stolen}`);
  assert.ok(await app.page.getByText("TRUSTED DRAW").count(), "the trusted one drew it");
});

browserTest(h, "an untrusted copy of Link embeds: the shipped built-in still draws link cards", { levers: { net: "replay" }, allowErrors: [/./] }, async (app) => {
  const m = { ...JSON.parse(readFileSync("web/src/extensions/link-embeds/extension.json", "utf8")), main: "index.js", files: ["index.js"] };
  await app.writeFile(".common-ink/extensions/link-embeds/extension.json", JSON.stringify(m));
  await app.writeFile(".common-ink/extensions/link-embeds/index.js", "export default { activate() {} };");
  await app.writeFile("Cards.md", "# Cards\n\nhttps://recorded.example/pen\n\nEnd.\n");
  await app.reload();
  await app.open("Cards");
  const drawn = await app.page.locator(".link-card .title", { hasText: "A recorded pen" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const activity = ((await app.state()) as unknown as { activity: Array<{ url?: string; outcome: string; reason?: string }> }).activity.filter((a) => a.url?.includes("recorded.example"));
  assert.ok(drawn, `no link card with an untrusted copy present; activity: ${JSON.stringify(activity)}`);
});
