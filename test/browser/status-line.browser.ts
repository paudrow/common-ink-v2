// The status line: on a laptop, the focused note's word count (the Words extension), and Offline or
// what's waiting only when there's something to say; on a phone, no status line, and a pill at the
// top whenever an edit hasn't reached the server.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
const OFFLINE = { allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::|status of 500/] };
const PHONE = { width: 375, height: 812 };

const words = (app: App) => app.page.locator('[data-item="words.count"]');
const shown = (app: App, selector: string) => app.page.locator(selector).isVisible();
const top = (app: App, selector: string) => app.page.locator(selector).evaluate((e) => e.getBoundingClientRect().top);

/** What the not-saved pill covers: controls, tabs and lines of the note, by their text. */
const covered = (app: App) =>
  app.page.evaluate(() => {
    const pill = document.querySelector("#not-saved")!.getBoundingClientRect();
    const overlaps = (r: DOMRect) => r.left < pill.right && pill.left < r.right && r.top < pill.bottom && pill.top < r.bottom;
    return [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=tab], .tab, .cm-line")]
      .filter((e) => e.id !== "not-saved" && e.checkVisibility() && overlaps(e.getBoundingClientRect()))
      .map((e) => e.getAttribute("aria-label") || e.textContent?.trim() || e.className);
  });

for (const width of [320, 375]) {
  browserTest(h, `at ${width}px the not-saved pill covers no tab, control or text of the note, and a tap on it stays on it`, { scenario: "empty", viewport: { width, height: 700 }, ...OFFLINE }, async (app) => {
    await app.writeFile("A note with a fairly long title.md", "# A note with a fairly long title\nalpha beta gamma delta epsilon zeta eta theta\n");
    await app.writeFile("B.md", "beta\n");
    await app.writeFile("C.md", "gamma\n");
    await app.goto({}, "A note with a fairly long title");
    await app.idle();
    await app.command("Keep tab open");
    await app.open("B");
    await app.command("Keep tab open");
    await app.open("C");
    await app.idle();
    const tabs = async () => (await app.state()).windows.flatMap((w) => w.tabs.map((t) => t.label));
    const before = await tabs();

    await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await app.call("cursor", 1, 1);
    await app.keys("Amore words here<Esc>");
    await app.page.locator("#not-saved", { hasText: "can't reach the server" }).waitFor();
    assert.deepEqual(await covered(app), [], "the longest wording");
    const pill = (await app.page.locator("#not-saved").boundingBox())!;
    await app.page.mouse.click(pill.x + pill.width - 6, pill.y + pill.height / 2);
    assert.deepEqual(await tabs(), before, "a tap on the pill closed nothing");
    assert.equal((await app.state()).focus.element, "div.cm-content.cm-lineWrapping", "and left the note focused");
    await app.page.unroute("**/api/file**");
    await app.page.locator("#not-saved").waitFor({ state: "hidden", timeout: 15_000 });

    await app.page.context().setOffline(true);
    await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline");
    await app.keys("Aagain<Esc>");
    await app.page.locator("#not-saved", { hasText: /^Not saved: offline\.$/ }).waitFor();
    assert.deepEqual(await covered(app), [], "the offline wording");
    await app.page.context().setOffline(false);
    // Back online, it's on its way: not "can't reach the server" while it waits for its retry.
    await app.page.locator("#not-saved", { hasText: /^Sending…$/ }).waitFor({ timeout: 2000 });
    assert.deepEqual(await covered(app), [], "the sending wording");
    await app.page.locator("#not-saved").waitFor({ state: "hidden", timeout: 15_000 });
  });
}

for (const width of [320, 375]) {
  browserTest(h, `at ${width}px a scrolled note's cursor line never sits under the not-saved pill`, { scenario: "empty", viewport: { width, height: 600 }, ...OFFLINE }, async (app) => {
    await app.writeFile("Long.md", Array.from({ length: 200 }, (_, i) => `Line ${i + 1} with words`).join("\n") + "\n");
    await app.goto({}, "Long");
    await app.idle();
    const cursorUnderPill = async () =>
      app.page.evaluate((text) => {
        const pill = document.querySelector("#not-saved")!.getBoundingClientRect();
        const line = [...document.querySelectorAll(".tab-editor:not([hidden]) .cm-line")].find((l) => l.textContent === text)!.getBoundingClientRect();
        return line.top < pill.bottom && pill.top < line.bottom;
      }, (await app.state()).cursor!.text);
    await app.keys("100G");
    await app.page.waitForTimeout(200);
    await app.keys("zt");
    // zt puts the line at the top while nothing floats over it.
    await app.page.waitForFunction(() => {
      const scroller = document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.getBoundingClientRect();
      const line = [...document.querySelectorAll(".tab-editor:not([hidden]) .cm-line")].find((l) => l.textContent === "Line 100 with words")?.getBoundingClientRect();
      return !!line && Math.abs(line.top - scroller.top) <= 6;
    });
    await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await app.keys("ix<Esc>");
    await app.page.locator("#not-saved", { hasText: "can't reach the server" }).waitFor();
    await app.page.waitForTimeout(100);
    assert.equal(await cursorUnderPill(), false, "the pill showing moves the cursor line out from under it");
    await app.keys("G50k");
    await app.page.waitForTimeout(150);
    assert.equal(await cursorUnderPill(), false, "after 50k");
    await app.keys("zt");
    await app.page.waitForTimeout(150);
    assert.equal(await cursorUnderPill(), false, "after zt");
    assert.equal((await app.state()).cursor?.line, 151);
    await app.page.unroute("**/api/file**");
  });
}

browserTest(h, "on a phone, a clash's pill is a button: Enter on it compares the two, and otherwise it's a status", { scenario: "empty", viewport: PHONE }, async (app) => {
  const note = "# Plan\n\nalpha\nbeta\ngamma\n";
  await app.writeFile("Plan.md", note);
  await app.goto({}, "Plan");
  await app.idle();
  const { revision } = (await (await app.page.context().request.get(`${app.base}/api/file?path=Plan.md`)).json()) as { revision: number };
  assert.equal(await app.page.locator("#not-saved").getAttribute("role"), "status");
  await app.call("cursor", 4, 1);
  await app.keys("A mine<Esc>");
  const res = await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", text: note.replace("beta", "beta theirs"), base: revision }, headers: { "X-Common-Ink-Agent": "Claude" } });
  assert.ok(res.ok(), `${res.status()}`);
  const pill = app.page.locator("#not-saved", { hasText: /^Not saved: changed elsewhere$/ });
  await pill.waitFor();
  assert.deepEqual(await pill.evaluate((e) => [e.getAttribute("role"), e.tabIndex]), ["button", 0]);
  await pill.focus();
  await app.page.keyboard.press("Enter");
  await app.page.locator(".clash").waitFor();
});

for (const viewport of [{ width: 1200, height: 800 }, PHONE])
  browserTest(h, `at ${viewport.width}px, a save failing leaves the scroll where you put it when the line you edited is out of sight`, { scenario: "empty", viewport, ...OFFLINE }, async (app) => {
    await app.writeFile("Long.md", Array.from({ length: 200 }, (_, i) => `Line ${i + 1} with words`).join("\n") + "\n");
    await app.goto({}, "Long");
    await app.idle();
    await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await app.keys("150Gix<Esc>");
    await app.page.waitForTimeout(200);
    await app.page.evaluate(() => (document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.scrollTop = 0));
    await app.page.locator("#unsent", { hasText: "1 unsent change" }).waitFor({ state: "attached" });
    if (viewport.width < 600) await app.page.locator("#not-saved", { hasText: "can't reach the server" }).waitFor();
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.scrollTop), 0);
    await app.page.unroute("**/api/file**");
  });

browserTest(h, "on a phone, Search covers the not-saved pill, and its Cancel takes a tap", { scenario: "empty", viewport: PHONE, ...OFFLINE }, async (app) => {
  await app.writeFile("A.md", "alpha body\n");
  await app.goto({}, "A");
  await app.idle();
  await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
  await app.keys("Gox<Esc>");
  await app.page.locator("#not-saved", { hasText: "can't reach the server" }).waitFor();
  await app.command("Search…");
  const cancel = app.page.locator("#command-bar .cancel");
  await cancel.waitFor();
  const box = (await cancel.boundingBox())!;
  assert.equal(await app.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("#command-bar .cancel"), [box.x + box.width / 2, box.y + box.height / 2]), true, "nothing is over Cancel");
  await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.locator("#command-bar").waitFor({ state: "hidden" });
  assert.equal(await app.page.locator("#not-saved").isVisible(), true, "the pill is there again");
  await app.page.unroute("**/api/file**");
});

for (const width of [320, 375])
  browserTest(h, `at ${width}px, over the Extensions panel, Trash and the calendar the pill floats at the bottom, off their headers' controls`, { scenario: "calendar", viewport: { width, height: 700 }, ...OFFLINE }, async (app) => {
    await app.writeFile("N.md", "# N\nsome words\n");
    await app.goto({}, "N");
    await app.idle();
    await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await app.keys("Gox<Esc>");
    const pill = app.page.locator("#not-saved", { hasText: "can't reach the server" });
    await pill.waitFor();
    assert.equal(await pill.getAttribute("data-at"), "top", "over a note, at the top");
    for (const command of ["Open trash", "Open calendar", "Show extensions"]) {
      await app.command(command);
      await app.page.waitForFunction(() => document.querySelector<HTMLElement>("#not-saved")?.dataset.at === "bottom");
      const under = await app.page.evaluate(() => {
        const p = document.querySelector("#not-saved")!.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, [role=tab], .tab")]
          .filter((e) => e.id !== "not-saved" && e.checkVisibility() && e.getBoundingClientRect().top < 140)
          .filter((e) => { const r = e.getBoundingClientRect(); return r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom; })
          .map((e) => e.getAttribute("aria-label") || e.textContent?.trim());
      });
      assert.deepEqual(under, [], `${command}: no control near the top is under the pill`);
    }
    await app.page.unroute("**/api/file**");
  });

browserTest(h, "a phone's notice stays a bar at the bottom while an edit isn't saved", { scenario: "empty", viewport: { width: 375, height: 700 }, ...OFFLINE }, async (app) => {
  await app.writeFile("A.md", "alpha body\n");
  await app.goto({}, "A");
  await app.idle();
  await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
  await app.keys("Gox<Esc>");
  await app.page.locator("#not-saved", { hasText: "can't reach the server" }).waitFor();
  await app.command("Split down").catch(() => {});
  const box = (await app.page.locator(".notice").first().boundingBox())!;
  assert.ok(box.height < 120, `the notice is ${Math.round(box.height)}px tall, from y ${Math.round(box.y)}`);
  await app.page.unroute("**/api/file**");
});

browserTest(h, "on a laptop the status line counts the focused note's words as you type, and says nothing about the server while it's reached", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip to Rome\n\n- [ ] Book the train\n\n```js\nconst left = 3;\n```\n::timer{duration=25m}\n<b>Pack</b>\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.writeFile("data.json", '{"one": "two three"}\n');
  await app.goto({}, "Trip");
  await app.idle();
  await words(app).filter({ hasText: /^7 words$/ }).waitFor();
  assert.equal(await app.page.locator("#unsent").textContent(), "");
  await app.call("cursor", 3, 1);
  await app.keys("A and the ferry<Esc>");
  await words(app).filter({ hasText: /^10 words$/ }).waitFor();
  await app.open("Other");
  await words(app).filter({ hasText: /^1 word$/ }).waitFor();
  await app.call("open", "data.json");
  await app.page.waitForFunction(() => document.title.startsWith("data"));
  await words(app).waitFor({ state: "hidden" });
  assert.equal(await shown(app, "#status"), true);
  assert.equal(await shown(app, "#not-saved"), false);
});

browserTest(h, "on a phone there's no status line and no counting; offline, a pill says an edit isn't saved until the server has it, without moving the note; wider, the count shows", { scenario: "empty", viewport: PHONE, ...OFFLINE }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  assert.equal(await shown(app, "#status"), false);
  assert.equal(await shown(app, "#not-saved"), false);
  assert.equal(await words(app).textContent(), "", "nothing counted where it can't be seen");
  const noteTop = await top(app, "#workbench");

  await app.page.context().setOffline(true);
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline");
  assert.equal(await shown(app, "#not-saved"), false, "offline with everything saved says nothing");

  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.locator("#not-saved", { hasText: /^Not saved: offline\.$/ }).waitFor();
  assert.equal(await top(app, "#workbench"), noteTop, "the note stays where it was");
  const pill = (await app.page.locator("#not-saved").boundingBox())!;
  assert.ok(pill.y >= 0 && pill.y + pill.height < 80 && pill.x + pill.width <= PHONE.width, `the pill is at the top, on screen: ${JSON.stringify(pill)}`);

  await app.page.context().setOffline(false);
  await app.page.locator("#not-saved").waitFor({ state: "hidden" });
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n", "the pill went once the server had the edit");

  await app.page.setViewportSize({ width: 1200, height: 800 });
  await words(app).filter({ hasText: /^2 words$/ }).waitFor();
});

browserTest(h, "on a phone, an edit the server fails to take says it isn't saved while the server is up, and the pill goes once it's in", { scenario: "empty", viewport: PHONE, ...OFFLINE }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  await app.page.route("**/api/file**", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : r.continue()));
  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.locator("#not-saved", { hasText: /^Not saved: can't reach the server\. Trying again\.$/ }).waitFor();
  assert.equal(await app.page.locator("#unsent").textContent(), "1 unsent change");
  assert.equal((await app.state()).network.unsent.length, 1);

  await app.page.unroute("**/api/file**");
  await app.page.locator("#not-saved").waitFor({ state: "hidden", timeout: 15_000 });
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n", "the pill went once the server had the edit");
});

browserTest(h, "typing in a 20,000-line note makes no long tasks: the count reads only the lines an edit touches", { scenario: "empty" }, async (app) => {
  const line = (i: number) => (i % 10 === 0 ? `## Heading ${i}` : i % 7 === 0 ? `- [ ] task ${i} [a link](https://ex.com/${i}) **bold**` : `The quick brown fox jumps over the dog, line ${i}.`);
  await app.writeFile("Big.md", Array.from({ length: 20_000 }, (_, i) => line(i)).join("\n") + "\n");
  // No save while it types: sending a megabyte isn't what this measures.
  await app.writeFile(".common-ink/settings.json", JSON.stringify({ "editor.saveDelay": 10_000 }));
  await app.goto({}, "Big");
  await app.idle();
  await words(app).filter({ hasText: /words$/ }).waitFor();
  const before = await words(app).textContent();
  await app.call("cursor", 3, 1);
  await app.keys("A");
  await app.page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver((list) => w.longTasks.push(...list.getEntries().map((e) => Math.round(e.duration)))).observe({ type: "longtask" });
  });
  for (const key of " one two three") {
    await app.page.waitForTimeout(150);
    await app.page.keyboard.press(key === " " ? "Space" : key);
  }
  await app.page.waitForTimeout(500);
  await app.keys("<Esc>");
  assert.deepEqual(await app.page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks), []);
  assert.equal(Number((await words(app).textContent())!.replace(/\D/g, "")), Number(before!.replace(/\D/g, "")) + 3);
});
