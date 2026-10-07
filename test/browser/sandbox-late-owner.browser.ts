// What a sandboxed extension registered stays its own, and only its own: an id or embed language that
// goes to another extension later (a trusted one put in once the device has a keyboard) runs and draws
// that extension's code, and a customized built-in you don't trust runs as it shipped.
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

// A trusted extension that goes in late (once a keyboard is found), and a sandboxed one with the same name
// in camelCase that asks for its command id first.
const LATE_TRUSTED = {
  name: "Word count",
  requires: { keyboard: true },
  activationEvents: ["onCommand:wordCount.secret"],
  contributes: { commands: [{ command: "wordCount.secret", title: "Count secretly" }] },
};
const LATE_TRUSTED_CODE = `export default { activate(ctx) { ctx.commands.register("wordCount.secret", () => console.log("TRUSTED HANDLER")); } };`;
const EARLY = {
  name: "Word count (sandboxed)",
  activationEvents: ["onStartup"],
  contributes: { commands: [{ command: "wordCount.secret", title: "Count secretly too" }] },
};
const EARLY_CODE = `export default { async activate(ctx) {
  let r; try { await ctx.commands.register("wordCount.secret", () => console.log("SANDBOX HANDLER")); r = "registered"; } catch (e) { r = "refused"; }
  console.log("EARLY " + r);
} };`;

browserTest(h, "on a phone, a trusted extension that goes in once a keyboard is found runs its own handler, not a sandboxed one's left under its id", { scenario: "empty", device: "phone", allowErrors: [/./] }, async (app) => {
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["wordCount"]\n}\n');
  await app.writeFile(".common-ink/extensions/wordCount/extension.json", JSON.stringify(LATE_TRUSTED));
  await app.writeFile(".common-ink/extensions/wordCount/index.js", LATE_TRUSTED_CODE);
  await app.writeFile(".common-ink/extensions/word-count/extension.json", JSON.stringify(EARLY));
  await app.writeFile(".common-ink/extensions/word-count/index.js", EARLY_CODE);
  await app.reload();
  await app.page.waitForTimeout(2000);
  // A keyboard is found: the trusted one goes in.
  for (const k of ["ArrowLeft", "Home", "Escape"]) await app.page.keyboard.press(k);
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  await app.page.waitForTimeout(1500);
  await app.call("command", "wordCount.secret");
  await app.page.waitForTimeout(2000);
  const said = logs.filter((l) => /HANDLER|EARLY/.test(l));
  // The id is the trusted extension's from load, even while it's off here, so the sandboxed one never gets it.
  assert.ok(said.includes("EARLY refused"), said.join("; "));
  assert.ok(!said.includes("SANDBOX HANDLER"), `running the trusted extension's command ran the sandboxed one's code: ${said.join("; ")}`);
  assert.ok(said.includes("TRUSTED HANDLER"), `the trusted one's handler ran: ${said.join("; ")}`);
});

// The same for an embed, which a sandboxed extension asks to draw while the trusted owner is off here.
const LATE_EMBED_OWNER = { ...OWNER, requires: { keyboard: true } };
const EARLY_THIEF = { ...THIEF, activationEvents: ["onStartup"] };

browserTest(h, "on a phone, a trusted embed owner that goes in once a keyboard is found draws its own embed, not a sandboxed drawer left under its language", { scenario: "empty", device: "phone", allowErrors: [/./] }, async (app) => {
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["secretbox"]\n}\n');
  await app.writeFile(".common-ink/extensions/secretbox/extension.json", JSON.stringify(LATE_EMBED_OWNER));
  await app.writeFile(".common-ink/extensions/secretbox/index.js", OWNER_CODE);
  await app.writeFile(".common-ink/extensions/thief/extension.json", JSON.stringify(EARLY_THIEF));
  await app.writeFile(".common-ink/extensions/thief/index.js", THIEF_CODE);
  await app.writeFile("Private.md", "# Private\n\n```secretbox\nkeep this to myself\n```\n");
  await app.reload();
  await app.page.waitForTimeout(2000);
  for (const k of ["ArrowLeft", "Home", "Escape"]) await app.page.keyboard.press(k);
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  await app.page.waitForTimeout(1500);
  await app.open("Private");
  await app.page.waitForTimeout(4000);
  const said = logs.filter((l) => /THIEF/.test(l));
  // The language is the trusted extension's even while it's off here, so the sandboxed one never gets it.
  assert.ok(said.includes("THIEF REGISTER refused"), said.join("; "));
  assert.ok(!said.some((l) => l.startsWith("THIEF GOT")), `after the owner went in, the sandboxed drawer still drew its embed: ${said.join("; ")}`);
});

// A view the trusted extension declares, while it's off here and once it goes in.
const VIEW_OWNER = {
  name: "Word count",
  requires: { keyboard: true },
  activationEvents: ["onCommand:wordCount.other"],
  contributes: { commands: [{ command: "wordCount.other", title: "Other" }], views: { sidebar: [{ id: "wordCount", name: "Counts" }] } },
};
const VIEW_OWNER_CODE = `export default { activate(ctx) { ctx.views.register("wordCount", { render(el) { el.textContent = "TRUSTED VIEW"; } }); } };`;
const VIEW_SQUAT = {
  name: "Word count (sandboxed)",
  activationEvents: ["onStartup"],
  contributes: { views: { sidebar: [{ id: "wordCount", name: "Counts too" }] } },
};
const VIEW_SQUAT_CODE = `export default { async activate(ctx) {
  let r; try { await ctx.views.register("wordCount", { resolve(w) { w.html = "<p>SANDBOX VIEW</p>"; console.log("SANDBOX DREW VIEW"); } }); r = "registered"; } catch (e) { r = "refused"; }
  console.log("SQUAT " + r);
} };`;

browserTest(h, "on a phone, a trusted view that goes in once a keyboard is found draws itself, not a sandboxed renderer left under its id", { scenario: "empty", device: "phone", allowErrors: [/./] }, async (app) => {
  const logs: string[] = [];
  app.page.on("console", (m) => logs.push(m.text()));
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", '{\n  "extensions.trusted": ["wordCount"]\n}\n');
  await app.writeFile(".common-ink/extensions/wordCount/extension.json", JSON.stringify(VIEW_OWNER));
  await app.writeFile(".common-ink/extensions/wordCount/index.js", VIEW_OWNER_CODE);
  await app.writeFile(".common-ink/extensions/word-count/extension.json", JSON.stringify(VIEW_SQUAT));
  await app.writeFile(".common-ink/extensions/word-count/index.js", VIEW_SQUAT_CODE);
  await app.reload();
  await app.page.waitForTimeout(2000);
  for (const k of ["ArrowLeft", "Home", "Escape"]) await app.page.keyboard.press(k);
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  await app.page.waitForTimeout(1500);
  await app.call("command", "wordCount.openInWindow");
  await app.page.waitForTimeout(3000);
  const said = logs.filter((l) => /SQUAT|SANDBOX DREW/.test(l));
  assert.deepEqual(said, ["SQUAT refused"]);
  await app.page.getByText("TRUSTED VIEW").first().waitFor();
});

// Vim's status item is Vim's while it's off here (a phone), and once a keyboard is found and Vim goes in.
const MODE = {
  name: "Moder",
  activationEvents: ["onStartup"],
  contributes: { statusBarItems: [{ id: "vim.mode", alignment: "left", priority: 100 }] },
};
const MODE_CODE = `export default { activate(ctx) { ctx.statusBar.set("vim.mode", "-- SPOOFED --"); } };`;

browserTest(h, "on a phone, a sandboxed extension can't take Vim's status item before Vim goes in", { scenario: "empty", device: "phone", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/moder/extension.json", JSON.stringify(MODE));
  await app.writeFile(".common-ink/extensions/moder/index.js", MODE_CODE);
  await app.writeFile("Plan.md", "# Plan\n\none\n");
  await app.reload();
  await app.page.waitForTimeout(1500);
  for (const k of ["ArrowLeft", "Home", "Escape"]) await app.page.keyboard.press(k);
  await app.page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
  await app.page.waitForTimeout(1500);
  await app.open("Plan");
  await app.page.waitForTimeout(1500);
  const shown = await app.page.locator('.status-item[data-item="vim.mode"]').allInnerTexts();
  assert.ok(!shown.some((t) => t.includes("SPOOFED")), `Vim's status item shows the sandboxed extension's text: ${JSON.stringify(shown)}`);
});
