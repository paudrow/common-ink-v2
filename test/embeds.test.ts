import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  Window: window.Window,
});

const { EditorView } = await import("@codemirror/view");
const { createState } = await import("../web/src/editor.ts");
const { DEFAULTS } = await import("../worker/src/settings.ts");
const { embeds, findEmbeds, parseInfo } = await import("../web/src/embeds.ts");
const clock = await import("../web/src/extensions/timers/clock.ts");
const { noiseSamples } = await import("../web/src/extensions/media/noise.ts");
const { exampleOf, listEmbeds } = await import("../worker/src/embed-list.ts");
const { findWorkspaceExtensions } = await import("../web/src/extension-host.ts");
const { memoryStore } = await import("./store.ts");
import type { Embed } from "../web/src/embeds.ts";
import type { FilePath } from "../worker/src/files.ts";

const NOTE = ["# Plan", "", "```timer duration=25m label=\"Deep work\"", "```", "", "```js", "code()", "```", "", "```timer id=tea duration=4m", "```", "", "```html-app height=200", "<p>hi</p>", "```", "", "End"].join("\n");

test("an info string is a language and key=value arguments, quoted or not", () => {
  assert.deepEqual(parseInfo('timer duration=25m label="Deep work"'), { language: "timer", args: { duration: "25m", label: "Deep work" } });
  assert.deepEqual(parseInfo("alarm at=07:30 label='Wake up'"), { language: "alarm", args: { at: "07:30", label: "Wake up" } });
  assert.deepEqual(parseInfo("python"), { language: "python", args: {} });
});

test("embeds are the fenced blocks of declared languages, each with a key that stays put", () => {
  const view = new EditorView({ state: createState(NOTE, { path: "Plan.md" as FilePath, json: false, readOnly: false, settings: DEFAULTS, extensions: [], onUpdate: () => {}, onBlur: () => {} }) });
  const found = findEmbeds(view.state, new Set(["timer", "html-app"])).map((f) => f.embed);
  assert.deepEqual(
    found.map((e) => [e.language, e.key, e.args, e.body]),
    [
      ["timer", "Plan.md#timer:0", { duration: "25m", label: "Deep work" }, ""],
      ["timer", "Plan.md#tea", { id: "tea", duration: "4m" }, ""],
      ["html-app", "Plan.md#html-app:0", { height: "200" }, "<p>hi</p>"],
    ],
    "an id argument names it; otherwise it's which block of its language it is; js isn't an embed",
  );
  view.destroy();
});

test("an embed is drawn in place of its block until the cursor is in it", () => {
  const drawn: Embed[] = [];
  const host = { languages: () => new Set(["timer"]), draw: (el: HTMLElement, e: Embed) => void (drawn.push(e), (el.textContent = `drawn ${e.args.duration}`)), needs: () => null };
  const view = new EditorView({
    state: createState(NOTE, { path: "Plan.md" as FilePath, json: false, readOnly: false, settings: DEFAULTS, extensions: [embeds(host)], onUpdate: () => {}, onBlur: () => {} }),
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.deepEqual([...view.dom.querySelectorAll(".cm-embed")].map((e) => e.textContent), ["drawn 25m", "drawn 4m"]);
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } });
  assert.deepEqual([...view.dom.querySelectorAll(".cm-embed")].map((e) => e.textContent), ["drawn 4m"], "the cursor in the first shows its markdown");
  view.destroy();
});

test("timers keep time as data: start, pause, run out, and an alarm rings once a day", () => {
  assert.equal(clock.parseDuration("1h30m"), 90 * 60_000);
  assert.equal(clock.parseDuration("90s"), 90_000);
  assert.equal(clock.parseDuration("25"), 25 * 60_000);
  assert.equal(clock.parseDuration("soon"), null);
  let c: import("../web/src/extensions/timers/clock.ts").Clock = { kind: "timer", label: "", duration: 60_000, running: false, since: 0, elapsed: 0, done: false, note: null };
  c = clock.start(c, 1000);
  assert.equal(clock.remainingAt(c, 31_000), 30_000);
  c = clock.pause(c, 31_000);
  assert.equal(clock.remainingAt(c, 999_999), 30_000, "paused, it holds");
  c = clock.start(c, 100_000);
  assert.equal(clock.settle(c, 120_000), c, "not yet");
  const done = clock.settle(c, 131_000);
  assert.deepEqual([done.running, done.done, clock.remainingAt(done, 200_000)], [false, true, 0]);
  assert.equal(clock.format(25 * 60_000), "25:00");
  assert.equal(clock.format(3_723_000), "1:02:03");

  const alarm = { at: "07:30", label: "", on: false, rang: null, note: null };
  const early = new Date(2026, 9, 5, 7, 0);
  const late = new Date(2026, 9, 5, 7, 31);
  const on = clock.switchOn(alarm, early);
  assert.equal(clock.due(on, early), false);
  assert.equal(clock.due(on, late), true);
  assert.equal(clock.due(clock.rung(on, late), new Date(2026, 9, 5, 9, 0)), false, "once a day");
  assert.equal(clock.due(clock.switchOn(alarm, late), late), false, "switched on after its time, it waits for tomorrow");
});

test("noise is made here: white is flat, brown is smoother", () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const roughness = (s: Float32Array) => s.slice(1).reduce((sum, v, i) => sum + Math.abs(v - s[i]), 0) / s.length;
  const white = noiseSamples("white", 4000, random);
  const brown = noiseSamples("brown", 4000, random);
  assert.ok(white.every((v) => v >= -0.5 && v <= 0.5));
  assert.ok(roughness(brown) < roughness(white) / 5, "brown noise changes slowly");
});

test("list_embeds lists every embed with its arguments and an example, and says which are off", async () => {
  const s = memoryStore();
  s.files.write({ path: ".common-ink/settings.json" as FilePath, text: JSON.stringify({ "extensions.disabled": ["media"] }), base: 0, author: { kind: "user", email: "you@example.com" } });
  const list = await listEmbeds(s, null);
  const timer = list.find((e) => e.language === "timer")!;
  assert.equal(timer.extension, "timers");
  assert.equal(timer.on, true);
  assert.equal(timer.example, "```timer duration=25m\n```");
  assert.equal(list.find((e) => e.language === "noise")?.on, false);
  assert.equal(exampleOf({ language: "html-app", title: "", description: "", arguments: { height: { type: "number", description: "", default: "360" } }, body: "<p>…</p>" }), "```html-app height=360\n<p>…</p>\n```");
});

test("an extension's state.json isn't part of it: changing it needs no reload", () => {
  const files = [
    { path: ".common-ink/extensions/pomodoro/extension.json" as FilePath, revision: 1 },
    { path: ".common-ink/extensions/pomodoro/index.js" as FilePath, revision: 1 },
    { path: ".common-ink/extensions/pomodoro/state.json" as FilePath, revision: 9 },
    { path: ".common-ink/extensions/timers/state.json" as FilePath, revision: 3 },
  ];
  const found = findWorkspaceExtensions(files);
  assert.deepEqual(found.map((w) => [w.id, w.files.length]), [["pomodoro", 2]], "and a built-in's state alone isn't an extension");
});
