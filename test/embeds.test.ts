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
const { StateEffect, Transaction } = await import("@codemirror/state");
const clock = await import("../web/src/extensions/timers/clock.ts");
const { noiseSamples } = await import("../web/src/extensions/media/noise.ts");
const { exampleOf, listEmbeds } = await import("../worker/src/embed-list.ts");
const { findWorkspaceExtensions } = await import("../web/src/extension-host.ts");
const { memoryStore } = await import("./store.ts");
import type { Embed, EmbedHost } from "../web/src/embeds.ts";
import type { EmbedContribution } from "../worker/src/extensions.ts";
import type { FilePath } from "../worker/src/files.ts";

const NOTE = [
  "# Plan",
  "",
  '::timer{duration=25m label="Deep work"}',
  "",
  "```js",
  "code()",
  "```",
  "",
  "::timer{id=tea duration=4m}",
  "",
  "::unknown{x=1}",
  "",
  ":::board{done=Shipped}",
  "## To do",
  "- [ ] Write it",
  ":::",
  "",
  "```html-app height=200",
  "<p>hi</p>",
  "```",
  "",
  "End",
].join("\n");

const DECLARED = new Map([
  ["timer", { syntax: "leaf" as const }],
  ["board", { syntax: "container" as const }],
  ["html-app", { syntax: "fence" as const }],
]);

const state = (doc: string, extensions: import("@codemirror/state").Extension[] = []) =>
  createState(doc, { path: "Plan.md" as FilePath, json: false, readOnly: false, settings: DEFAULTS, extensions, onUpdate: () => {}, onBlur: () => {} });

test("an info string is a language and key=value arguments, quoted or not, kept in order with their quotes", () => {
  assert.deepEqual(parseInfo('timer duration=25m label="Deep work"'), {
    language: "timer",
    attrs: [
      { key: "duration", value: "25m", quote: "" },
      { key: "label", value: "Deep work", quote: '"' },
    ],
  });
  assert.deepEqual(parseInfo("alarm at=07:30 label='Wake up'").attrs.map((a) => [a.key, a.value, a.quote]), [
    ["at", "07:30", ""],
    ["label", "Wake up", "'"],
  ]);
  assert.deepEqual(parseInfo("python"), { language: "python", attrs: [] });
});

test("embeds are written as their contribution says: a leaf line, a container, or a fence; each with a key that stays put", () => {
  const scan = findEmbeds(state(NOTE), DECLARED);
  assert.deepEqual(
    scan.found.map(({ embed: e }) => [e.language, e.syntax, e.key, e.args, e.body]),
    [
      ["timer", "leaf", "Plan.md#timer:0", { duration: "25m", label: "Deep work" }, ""],
      ["timer", "leaf", "Plan.md#tea", { id: "tea", duration: "4m" }, ""],
      ["board", "container", "Plan.md#board:0", { done: "Shipped" }, "## To do\n- [ ] Write it"],
      ["html-app", "fence", "Plan.md#html-app:0", { height: "200" }, "<p>hi</p>"],
    ],
    "an id argument names it; otherwise it's which of its kind it is. js and an undeclared directive aren't embeds",
  );
  assert.deepEqual(scan.unclosed, []);
  assert.deepEqual(findEmbeds(state("```timer duration=5m\n```"), DECLARED).found, [], "a leaf embed written as a fence is just code");
});

test("a container left open isn't an embed, and says so above it", () => {
  const view = new EditorView({ state: state(":::board\n## To do\n- Card\n\nEnd", [embeds(host([]))]), parent: document.body });
  assert.deepEqual(findEmbeds(view.state, DECLARED).unclosed, [{ from: 0, language: "board" }]);
  assert.equal(view.dom.querySelector(".cm-embed-needs")?.textContent, "This Board isn't closed: add a line with ::: after its last line.");
  assert.equal(view.dom.querySelectorAll(".cm-embed").length, 0);
  view.destroy();
});

/** A host that draws each embed as its arguments, and takes new ones in place unless told not to. */
function host(drawn: Embed[], opts: { updates?: Embed[]; refuse?: boolean } = {}): EmbedHost {
  const contributions = new Map<string, EmbedContribution>([
    ["timer", { language: "timer", title: "Timer", description: "", syntax: "leaf", arguments: { duration: { type: "duration", description: "How long", default: "25m", presets: ["5m", "25m"] }, label: { type: "string", description: "What it's for" }, id: { type: "string", description: "", hidden: true } } }],
    ["board", { language: "board", title: "Board", description: "", syntax: "container", arguments: {} }],
  ]);
  return {
    contributions: () => contributions,
    draw: (el, e) => void (drawn.push(e), (el.textContent = `drawn ${e.args.duration ?? e.language}`)),
    update: (el, e) => {
      if (opts.refuse) return false;
      opts.updates?.push(e);
      el.textContent = `drawn ${e.args.duration}`;
      return true;
    },
    needs: () => null,
    urlEmbed: () => null,
    drawUrl: () => {},
  };
}

test("an embed is drawn in place of its markdown until the cursor is on it, with Settings and Edit markdown; it's kept, hidden, meanwhile", () => {
  const drawn: Embed[] = [];
  const view = new EditorView({ state: state(NOTE, [embeds(host(drawn))]), parent: document.body });
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const bodies = () => [...view.dom.querySelectorAll(".cm-embed:not(.is-hidden) .cm-embed-body")].map((e) => e.textContent);
  assert.deepEqual(bodies(), ["drawn 25m", "drawn 4m", "drawn board"]);
  assert.deepEqual([...view.dom.querySelector(".cm-embed .cm-embed-tools")!.querySelectorAll("button")].map((b) => b.textContent), ["Settings", "Edit markdown"]);
  const timer = view.dom.querySelector(".cm-embed");
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } });
  assert.deepEqual(bodies(), ["drawn 4m", "drawn board"], "the cursor on the first shows its markdown");
  assert.ok(timer!.isConnected && timer!.classList.contains("is-hidden"), "kept, hidden");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(view.dom.querySelector(".cm-embed"), timer, "and shown again: the same box, not drawn again");
  assert.equal(drawn.length, 3, "each drawn once");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.dom.querySelectorAll<HTMLButtonElement>(".cm-embed-tools button")[1].click();
  assert.equal(view.state.selection.main.head, view.state.doc.line(3).to, "Edit markdown puts the cursor at the end of its line");
  view.destroy();
});

test("new arguments go to the drawn embed in place: its element stays, unless its extension can't take them", () => {
  const drawn: Embed[] = [];
  const updates: Embed[] = [];
  const view = new EditorView({ state: state(NOTE, [embeds(host(drawn, { updates }))]), parent: document.body });
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const first = view.dom.querySelector(".cm-embed")!;
  const line = view.state.doc.line(3);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: '::timer{duration=50m label="Deep work"}' } });
  assert.equal(view.dom.querySelector(".cm-embed"), first, "the same element");
  assert.deepEqual(updates.map((e) => e.args.duration), ["50m"]);
  assert.equal(first.querySelector(".cm-embed-body")!.textContent, "drawn 50m");
  view.dispatch({ changes: { from: 0, insert: "Intro\n\n" } });
  assert.equal(view.dom.querySelector(".cm-embed"), first, "an edit elsewhere leaves it alone");
  assert.equal(updates.length, 1);
  view.destroy();

  const refusing = new EditorView({ state: state(NOTE, [embeds(host([], { refuse: true }))]), parent: document.body });
  refusing.dispatch({ selection: { anchor: refusing.state.doc.length } });
  const before = refusing.dom.querySelector(".cm-embed")!;
  const l = refusing.state.doc.line(3);
  refusing.dispatch({ changes: { from: l.from, to: l.to, insert: "::timer{duration=50m}" } });
  assert.notEqual(refusing.dom.querySelector(".cm-embed"), before, "drawn again");
  refusing.destroy();
});

test("Settings writes the arguments into the markdown as your edit, keeping their order and quotes and leaving defaults out", async () => {
  const view = new EditorView({ state: state('# Plan\n\n::timer{label="Deep work" id=tea}\n\nEnd', [embeds(host([]))]), parent: document.body });
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const events: string[] = [];
  const listen = EditorView.updateListener.of((u) => u.transactions.forEach((tr) => tr.docChanged && events.push(tr.annotation(Transaction.userEvent) ?? "")));
  view.dispatch({ effects: StateEffect.appendConfig.of(listen) });
  view.dom.querySelector<HTMLButtonElement>(".cm-embed-tools button")!.click();
  const form = view.dom.querySelector<HTMLFormElement>(".cm-embed-form")!;
  assert.deepEqual([...form.querySelectorAll("label")].map((l) => l.textContent), ["Duration", "Label"], "an id isn't offered");
  const [duration, label] = [...form.querySelectorAll("input")];
  assert.equal(duration.value, "25m", "a default shows as its value");
  assert.equal(form.querySelector(".actions code")!.textContent, '::timer{label="Deep work" id=tea}', "and isn't written");
  form.querySelectorAll<HTMLButtonElement>(".presets button")[0].click();
  label.value = "Tea, then work";
  label.dispatchEvent(new window.Event("input"));
  assert.equal(form.querySelector(".actions code")!.textContent, '::timer{label="Tea, then work" duration=5m id=tea}');
  duration.value = "soon";
  duration.dispatchEvent(new window.Event("input"));
  assert.equal(form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled, true, "a duration it can't read can't be saved");
  duration.value = "5m";
  duration.dispatchEvent(new window.Event("input"));
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  assert.equal(view.state.doc.line(3).text, '::timer{label="Tea, then work" duration=5m id=tea}');
  assert.deepEqual(events, ["input.embed"], "one edit, yours");
  const { embedForm } = await import("../web/src/embed-form.ts");
  const choice = embedForm(
    { language: "tasks", title: "Task list", description: "", syntax: "leaf", arguments: { due: { type: "string", description: "", enum: ["today", "week"] }, sort: { type: "string", description: "", default: "due", enum: ["due", "title"] } } },
    [],
    { preview: () => "", save: () => {}, cancel: () => {} },
  );
  assert.deepEqual(
    [...choice.querySelectorAll("select")].map((sel) => [...sel.options].map((o) => o.value)),
    [
      ["", "today", "week"],
      ["due", "title"],
    ],
    "a choice without a default can be left out; one with a default can't",
  );
  assert.equal(view.dom.querySelector(".cm-embed-form"), null);
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
  assert.equal(timer.syntax, "leaf");
  assert.equal(timer.example, "::timer{duration=25m}");
  assert.equal(list.find((e) => e.language === "noise")?.on, false);
  assert.equal(list.find((e) => e.language === "noise")?.example, "::noise{color=brown volume=0.3}");
  assert.equal(exampleOf({ language: "html-app", title: "", description: "", syntax: "fence", arguments: { height: { type: "number", description: "", default: "360" } }, body: "<p>…</p>" }), "```html-app height=360\n<p>…</p>\n```");
  assert.equal(exampleOf({ language: "board", title: "", description: "", syntax: "container", arguments: { done: { type: "string", description: "", default: "Shipped it" } }, body: "## Column" }), ':::board{done="Shipped it"}\n## Column\n:::');
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
