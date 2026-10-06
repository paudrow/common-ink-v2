// Ways out of the sandbox that don't go through its frame's own limits (ADR 0006): its shells loaded
// somewhere other than the app's sandboxed frames, and a sandboxed extension writing the files that
// decide what runs in the page and what extensions may do.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

test("the sandbox's shells are sandboxed by their own policy wherever they load, and only the app may frame them", async () => {
  const context = await h.browser.newContext();
  const page = await context.newPage();
  for (const shell of ["host", "webview"]) {
    await page.goto(`${h.base}/sandbox/${shell}`);
    assert.equal(await page.evaluate(() => window.origin), "null", `${shell}, opened by itself`);
  }
  // Another origin (a page on another port) frames the webview shell, as it would to hand it HTML.
  const framing = createServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(`<iframe src="${h.base}/sandbox/webview"></iframe><iframe src="${h.base}/sandbox/vendor/three/three.module.js"></iframe>`));
  await new Promise<void>((resolve) => framing.listen(0, "127.0.0.1", resolve));
  await page.goto(`http://127.0.0.1:${(framing.address() as AddressInfo).port}/`);
  await page.waitForTimeout(1000);
  const frames = page.frames().slice(1).map((f) => f.url());
  framing.close();
  assert.ok(frames.includes(`${h.base}/sandbox/vendor/three/three.module.js`), `a frame from the app's address can load there: ${frames}`);
  assert.ok(!frames.includes(`${h.base}/sandbox/webview`), `the webview shell didn't: ${frames}`);
  await context.close();
});

const GRABBY = {
  name: "Grabby",
  activationEvents: ["onCommand:grabby.run", "onCommand:grabby.where"],
  permissions: { "files:write": { paths: ["**"], why: "Tidy everything" } },
  contributes: {
    commands: [
      { command: "grabby.run", title: "Run Grabby" },
      { command: "grabby.where", title: "Where is Grabby" },
    ],
  },
};

// Each file, as a string, a String object and an array: the frame's messages are structured clones,
// which keep both, and either reads as the path once something turns it into a string.
const GRAB = `export default { activate(ctx) {
  const trust = '{ "extensions.trusted": ["grabby"] }\\n';
  ctx.commands.register("grabby.run", async () => {
    const r = {};
    const t = async (k, p, text) => {
      for (const [how, path] of [["plain", p], ["boxed", new String(p)], ["array", [p]]]) {
        try { await ctx.files.write(path, text, 0); r[k + " " + how] = "written"; } catch (e) { r[k + " " + how] = "refused"; }
      }
    };
    await t("note", "Tidy.md", "# Tidy\\n");
    await t("workspaceSettings", ".common-ink/settings.json", trust);
    await t("userSettings", ".common-ink/users/" + ctx.me + "/settings.json", trust);
    await t("ownManifest", ".common-ink/extensions/grabby/extension.json", "{}");
    await t("anotherExtension", ".common-ink/extensions/other/index.js", "export default { activate() {} };\\n");
    await ctx.workbench.notice("GRABBY " + JSON.stringify(r));
  });
  ctx.commands.register("grabby.where", () => ctx.workbench.notice("WHERE " + self.origin));
} };`;

browserTest(
  h,
  "a sandboxed extension allowed to change every file still can't change who's trusted, what's allowed, or any extension's files, however it passes the path",
  { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/can't change|isn't a file path/] },
  async (app) => {
    await app.writeFile(".common-ink/extensions/grabby/extension.json", JSON.stringify(GRABBY));
    await app.writeFile(".common-ink/extensions/grabby/index.js", GRAB);
    await app.reload();
    await app.command("Run Grabby");
    const said = await app.page.locator(".notice p", { hasText: "GRABBY" }).textContent();
    const written = Object.entries(JSON.parse(said!.slice(said!.indexOf("{")))).filter(([, how]) => how === "written").map(([what]) => what);
    assert.deepEqual(written, ["note plain"]);
    assert.equal(await app.readFile(".common-ink/settings.json"), "");
    assert.equal(await app.readFile(".common-ink/users/tester@localhost/settings.json"), "");
    assert.equal(await app.readFile(".common-ink/extensions/other/index.js"), "");
    await app.reload();
    await app.command("Where is Grabby");
    assert.equal(await app.page.locator(".notice p", { hasText: "WHERE" }).textContent(), "Grabby: WHERE null", "still sandboxed after a reload");
  },
);

test("the Worker refuses an untrusted extension's change to the files that decide trust, but not its own state", async () => {
  const write = async (path: string, extension: string) => {
    const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
    const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
    return fetch(`${h.base}/api/file`, { method: "PUT", headers: { "X-Common-Ink-Extension": extension }, body: JSON.stringify({ path, text: "{}\n", base }) });
  };
  assert.equal((await write(".common-ink/settings.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/users/tester@localhost/settings.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/other/index.js", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/grabby/installed.json", "grabby")).status, 403);
  assert.equal((await write(".common-ink/extensions/grabby/state.json", "grabby")).status, 200);
  assert.equal((await write("Grabby was here.md", "grabby")).status, 200);
});

test("the Worker's gate covers undo, and an extension name it couldn't have", async () => {
  const put = async (path: string, text: string, headers: Record<string, string> = {}) => {
    const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
    const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
    return fetch(`${h.base}/api/file`, { method: "PUT", headers, body: JSON.stringify({ path, text, base }) });
  };
  const change = (await (await put(".common-ink/settings.json", '{ "extensions.trusted": [] }\n')).json()) as { file: { revision: number } };
  const undo = await fetch(`${h.base}/api/undo`, { method: "POST", headers: { "X-Common-Ink-Extension": "grabby" }, body: JSON.stringify({ revisions: [change.file.revision] }) });
  assert.equal(undo.status, 403);
  assert.equal((await put(".common-ink/extensions/grabby/sub/state.json", "{}\n", { "X-Common-Ink-Extension": "grabby/sub" })).status, 400);
  assert.equal((await put(".common-ink/settings.json", "{}\n", { "X-Common-Ink-Extension": "" })).status, 400);
});

const BIG = {
  name: "Biggy",
  activationEvents: ["onCommand:biggy.run"],
  permissions: { "files:write": { paths: ["**"], why: "Write a lot" } },
  contributes: { commands: [{ command: "biggy.run", title: "Run Biggy" }] },
};

const BIGGY = `export default { activate(ctx) {
  ctx.commands.register("biggy.run", async () => {
    const r = [];
    for (const [path, text] of [["Big.md", "x".repeat(3000000)], [".common-ink/extensions/biggy/state.json", "{}"]]) {
      try { await ctx.files.write(path, text, 0); r.push("written"); } catch (e) { r.push(e.message); }
    }
    await ctx.workbench.notice("BIGGY " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension's call is refused past a size, and writing its own state as a file points at ctx.state", { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/biggy/extension.json", JSON.stringify(BIG));
  await app.writeFile(".common-ink/extensions/biggy/index.js", BIGGY);
  await app.reload();
  await app.command("Run Biggy");
  const said = (await app.page.locator(".notice p", { hasText: "BIGGY" }).textContent())!;
  assert.deepEqual(JSON.parse(said.slice(said.indexOf("["))), [
    "Biggy sent more than 2,000,000 characters' worth in one call",
    "Biggy can't change its own state.json as a file: use ctx.state",
  ]);
  assert.equal(await app.readFile("Big.md"), "");
});

const FLOOD = {
  name: "Flood",
  activationEvents: ["onCommand:flood.run"],
  permissions: { "files:write": { paths: ["Flood/**"], why: "Write a lot" } },
  contributes: { commands: [{ command: "flood.run", title: "Run Flood" }] },
};

const FLOODING = `export default { activate(ctx) {
  ctx.commandBar.provide({ prefix: "flood ", placeholder: "", items: async () => [{ label: "x".repeat(3000000), run() {} }, { label: "small", run() {} }] });
  ctx.commands.register("flood.run", async () => {
    const r = {};
    try { await ctx.state.set(new Array(3000000).fill(7)); r.numbers = "kept"; } catch (e) { r.numbers = e.message; }
    let written = 0, refused = "";
    for (let i = 0; i < 25; i++) { try { await ctx.files.write("Flood/" + i + ".md", "m".repeat(990000), 0); written++; } catch (e) { refused = e.message; } }
    r.written = written;
    r.refused = refused;
    await ctx.workbench.notice("FLOOD " + JSON.stringify(r));
  });
} };`;

browserTest(h, "a sandboxed extension can't get past the size of a call with numbers, or send more than its share in a moment, or answer with too much", { scenario: "empty", levers: { permissions: "allow" }, allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/flood/extension.json", JSON.stringify(FLOOD));
  await app.writeFile(".common-ink/extensions/flood/index.js", FLOODING);
  await app.reload();
  await app.command("Run Flood");
  const said = (await app.page.locator(".notice p", { hasText: "FLOOD" }).textContent({ timeout: 60000 }))!;
  const r = JSON.parse(said.slice(said.indexOf("{"))) as { numbers: string; written: number; refused: string };
  assert.equal(r.numbers, "Flood sent more than 2,000,000 characters' worth in one call");
  assert.ok(r.written >= 5 && r.written < 25, `wrote ${r.written} of 25`);
  assert.equal(r.refused, "Flood is sending too much at once: it can send 10,000,000 characters' worth every 10 seconds");
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  await app.page.locator("#command-bar input").fill("flood ");
  await app.page.waitForTimeout(1500);
  const items = await app.page.locator("#command-bar li").allTextContents();
  assert.ok(!items.some((t) => t.length > 1000), "the oversized answer wasn't shown");
});

const SPAMMER = {
  name: "Spammer",
  activationEvents: ["onCommand:spammer.run"],
  contributes: { commands: [{ command: "spammer.run", title: "Run Spammer" }] },
};

const SPAM = `export default { activate(ctx) {
  ctx.commands.register("spammer.run", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 100000 }, () => ctx.commands.shortcut("nope")));
    const refused = rs.filter((r) => r.status === "rejected");
    const said = "SPAM " + JSON.stringify({ taken: rs.length - refused.length, why: refused[0] && refused[0].reason.message });
    // Its share is spent for this moment: it says so once there's room again.
    for (let i = 0; i < 30; i++) {
      try { return await ctx.workbench.notice(said); } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  });
} };`;

const NEIGHBOR = {
  name: "Neighbor",
  activationEvents: ["onCommand:neighbor.run"],
  contributes: { commands: [{ command: "neighbor.run", title: "Run Neighbor" }] },
};

const NEIGHBORLY = `export default { activate(ctx) {
  ctx.commands.register("neighbor.run", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => ctx.commands.shortcut("nope")));
    await ctx.workbench.notice("NEIGHBOR " + JSON.stringify({ answered: rs.filter((r) => r.status === "fulfilled").length }));
  });
} };`;

/**
 * The page's main thread's CPU time, in ms (CDP's ThreadTime). Not the time on the clock: on a busy
 * machine (CI's runners, two test files at once) the clock also counts the page waiting its turn while
 * the flooding frame's own process and other tests run, which swung a wall-time comparison from 1.2 to
 * over 3 times its baseline with nothing in the app changed.
 */
async function pageCpu(app: App) {
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  return async () => {
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
    return metrics.find((m) => m.name === "ThreadTime")!.value * 1000;
  };
}

/** What 100,000 calls and their answers cost the page with nothing done for them: a port in the page answering each at once. */
async function messagesAlone(app: App, cpu: () => Promise<number>) {
  const before = await cpu();
  await app.page.evaluate(async () => {
    const { port1, port2 } = new MessageChannel();
    port2.onmessage = (e) => port2.postMessage({ t: "reject", id: (e.data as { id: string }).id, message: "no" });
    await new Promise<void>((done) => {
      let answered = 0;
      port1.onmessage = () => ++answered === 100_000 && done();
      for (let i = 0; i < 100_000; i++) port1.postMessage({ t: "call", id: `h${i}`, method: "commands.shortcut", args: ["nope"] });
    });
  });
  return (await cpu()) - before;
}

browserTest(h, "a flood of tiny calls from a sandboxed frame is cut off by count, refused at the cost of its messages, and leaves other frames their share", { scenario: "empty", allowErrors: [/./] }, async (app) => {
  await app.writeFile(".common-ink/extensions/spammer/extension.json", JSON.stringify(SPAMMER));
  await app.writeFile(".common-ink/extensions/spammer/index.js", SPAM);
  await app.writeFile(".common-ink/extensions/neighbor/extension.json", JSON.stringify(NEIGHBOR));
  await app.writeFile(".common-ink/extensions/neighbor/index.js", NEIGHBORLY);
  await app.reload();
  const cpu = await pageCpu(app);
  const alone = [await messagesAlone(app, cpu)];
  // What the page makes for each refusal, counted: a refusal is a message with words made once, so no
  // Error and no number written out per refused call. (The version that did both stalled the page 2.5 to 4 times longer.)
  await app.page.evaluate(() => {
    const w = window as unknown as { Error: ErrorConstructor; made: { errors: number; numbers: number } };
    w.made = { errors: 0, numbers: 0 };
    // Built code calls Error() without new, which makes one all the same.
    w.Error = new Proxy(Error, {
      construct: (target, args, made) => (w.made.errors++, Reflect.construct(target, args, made)),
      apply: (target, self, args) => (w.made.errors++, Reflect.apply(target, self, args)),
    });
    const toLocale = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function (this: number, ...args: Parameters<typeof toLocale>) {
      w.made.numbers++;
      return toLocale.apply(this, args);
    };
  });
  const before = await cpu();
  await app.command("Run Spammer");
  const said = (await app.page.locator(".notice p", { hasText: "SPAM" }).textContent({ timeout: 120_000 }))!;
  const flood = (await cpu()) - before;
  const made = await app.page.evaluate(() => (window as unknown as { made: { errors: number; numbers: number } }).made);
  const r = JSON.parse(said.slice(said.indexOf("{"))) as { taken: number; why: string };
  assert.equal(r.why, "Spammer is calling too often: it can make 2,000 calls every 10 seconds");
  // Its own start (registering its command) counts toward the 2,000 too.
  assert.ok(r.taken > 1990 && r.taken <= 2000, `took ${r.taken}`);
  assert.ok(made.errors < 100 && made.numbers < 100, `refusing 98,000 calls, the page made ${made.errors} Errors and wrote ${made.numbers} numbers`);

  // Its share spent, another frame's calls are answered: the share is each frame's own.
  await app.command("Run Neighbor");
  const neighbor = (await app.page.locator(".notice p", { hasText: "NEIGHBOR" }).textContent({ timeout: 30_000 }))!;
  assert.deepEqual(JSON.parse(neighbor.slice(neighbor.indexOf("{"))), { answered: 20 });

  // And the page kept running: the flood, and the ten seconds its share was spent, took the page's thread
  // about what 100,000 messages alone do, measured either side of it. Here that's 1.3 to 2.7 times the
  // larger of the two: the messages from another process cost more than ones within the page, and vary.
  alone.push(await messagesAlone(app, cpu));
  const baseline = Math.max(...alone);
  console.log(`flood ${Math.round(flood)} ms of the page's CPU, its messages alone ${alone.map(Math.round).join(" and ")} ms`);
  assert.ok(flood < 4 * baseline + 500, `the flood took ${Math.round(flood)} ms of the page's CPU, against ${Math.round(baseline)} ms for its messages alone`);
});
