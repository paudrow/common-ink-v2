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

const WRITER = `export default { activate(ctx) {
  ctx.commands.register("planner.run", async () => {
    const r = {};
    const edit = await ctx.data.calendar.update("event:sample/work/standup", { title: "Moved" }, "this");
    r.edit = edit;
    try { r.status = await ctx.data.status(); } catch (e) { r.status = "refused"; }
    await ctx.workbench.notice("WRITER " + JSON.stringify(r));
  });
} };`;

browserTest(h, "an extension that may only change events learns nothing about them from its edits or the source's status", { scenario: "calendar", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/planner/extension.json", JSON.stringify(PLANNER));
  await app.writeFile(".common-ink/extensions/planner/index.js", WRITER);
  await app.page.route(/\/api\/event$/, (route) =>
    route.fulfill({ json: { status: "saved", address: "event:sample/work/standup", written: [{ id: "standup", title: "Board meeting about layoffs" }], deleted: ["event:sample/work/x"] } }),
  );
  await app.reload();
  await app.command("Run Planner");
  const said = (await app.page.locator(".notice p", { hasText: "WRITER" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), { edit: { status: "saved", address: "event:sample/work/standup" }, status: "refused" });
});

const REFUSED = `export default { activate(ctx) {
  ctx.commands.register("planner.run", async () => {
    const r = {};
    try { await ctx.data.calendar.update("event:sample/work/standup", { title: "Moved" }, "this"); r.refused = "no"; } catch (e) { r.refused = e.message; }
    r.queued = await ctx.data.calendar.update("event:sample/work/standup", { title: "Moved again" }, "this");
    await ctx.workbench.notice("REFUSED " + JSON.stringify(r));
  });
} };`;

browserTest(h, "when Google refuses or holds a write-only extension's edit, what it hears doesn't name the event", { scenario: "calendar", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/planner/extension.json", JSON.stringify(PLANNER));
  await app.writeFile(".common-ink/extensions/planner/index.js", REFUSED);
  let calls = 0;
  await app.page.route(/\/api\/event$/, (route) =>
    ++calls === 1
      ? route.fulfill({ status: 400, json: { error: "Google Calendar refused the change to Board meeting about layoffs: it was deleted" } })
      : route.fulfill({ json: { status: "queued", address: "event:sample/work/standup", written: [], deleted: [], error: "Google Calendar has a newer Board meeting about layoffs" } }),
  );
  await app.reload();
  await app.command("Run Planner");
  const said = (await app.page.locator(".notice p", { hasText: "REFUSED" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("{"))), {
    refused: "The calendar refused Planner's change to the event",
    queued: { status: "queued", address: "event:sample/work/standup", error: "The calendar doesn't have Planner's change yet" },
  });
});
