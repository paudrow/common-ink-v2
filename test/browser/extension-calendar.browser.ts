// What the page sends the Worker for a sandboxed extension's calendar edits: the event's fields it
// passed, with an id the app makes, and an address and scope that are what they say.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const PLANNER = {
  name: "Planner",
  activationEvents: ["onCommand:planner.run"],
  permissions: { "data:calendar:write": { why: "Add events" } },
  contributes: { commands: [{ command: "planner.run", title: "Run Planner" }] },
};

const PLAN = `export default { activate(ctx) {
  ctx.commands.register("planner.run", async () => {
    await ctx.data.calendar.create({ id: "dentist", title: "Lunch", start: "2026-10-06T12:00", end: "2026-10-06T13:00", calendar: "work", op: "delete", address: "event:sample/work/standup" });
    await ctx.data.calendar.update("event:sample/work/lunch", { title: "Long lunch", address: "event:sample/personal/dentist", scope: "all" }, "this");
    await ctx.workbench.notice("PLANNED");
  });
} };`;

browserTest(h, "a sandboxed extension's new event gets the app's id, and only the fields an event has", { scenario: "calendar", levers: { permissions: "allow" } }, async (app) => {
  await app.writeFile(".common-ink/extensions/planner/extension.json", JSON.stringify(PLANNER));
  await app.writeFile(".common-ink/extensions/planner/index.js", PLAN);
  const sent: Array<Record<string, unknown>> = [];
  await app.page.route(/\/api\/events?$/, async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({ json: { status: "saved", address: "event:sample/work/x", written: [], deleted: [] } });
  });
  await app.reload();
  await app.command("Run Planner");
  await app.page.locator(".notice p", { hasText: "PLANNED" }).waitFor();
  const [created, updated] = sent.map(({ zone: _zone, ...rest }) => rest);
  assert.match(String(created.id), /^[0-9a-v]{5,1024}$/);
  assert.notEqual(created.id, "dentist");
  assert.deepEqual({ ...created, id: "made" }, { id: "made", title: "Lunch", start: "2026-10-06T12:00", end: "2026-10-06T13:00", calendar: "work" });
  assert.deepEqual(updated, { title: "Long lunch", address: "event:sample/work/lunch", scope: "this" });
});

const SLOPPY = `export default { activate(ctx) {
  ctx.commands.register("planner.run", async () => {
    const r = {};
    const t = async (k, f) => { try { await f(); r[k] = "sent"; } catch (e) { r[k] = "refused"; } };
    await t("remove with an odd scope", () => ctx.data.calendar.remove("event:sample/work/standup", { x: 1 }));
    await t("update with a made-up scope", () => ctx.data.calendar.update("event:sample/work/standup", { title: "Renamed" }, "bogus"));
    await t("create with wrong types", () => ctx.data.calendar.create({ title: "Lunch", start: "2026-10-06T12:00", end: 5, timeZone: 7 }));
    await t("update with a wrong type", () => ctx.data.calendar.update("event:sample/work/standup", { allDay: "yes" }));
    await t("update with no scope", () => ctx.data.calendar.update("event:sample/work/standup", { title: "Fine" }));
    await ctx.workbench.notice("SLOPPY " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension's event edit with a scope or field it can't have is refused, not sent with a default", { scenario: "calendar", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/planner/extension.json", JSON.stringify(PLANNER));
  await app.writeFile(".common-ink/extensions/planner/index.js", SLOPPY);
  const sent: unknown[] = [];
  await app.page.route(/\/api\/events?$/, async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({ json: { status: "saved", address: "event:sample/work/standup", written: [], deleted: [] } });
  });
  await app.reload();
  await app.command("Run Planner");
  const said = (await app.page.locator(".notice p", { hasText: "SLOPPY" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), {
    "remove with an odd scope": "refused",
    "update with a made-up scope": "refused",
    "create with wrong types": "refused",
    "update with a wrong type": "refused",
    "update with no scope": "sent",
  });
  assert.equal(sent.length, 1);
});
