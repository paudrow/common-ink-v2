// window.__commonInk, with test levers on (docs/TESTING.md): the app's state as plain data, key presses
// that go through the editor as real ones do, a wait for the app to settle, and the geometry checks.
// For browser tests, the probe CLI, and agents driving the app from a console.
import { getCM } from "@replit/codemirror-vim";
import { syntaxParserRunning, syntaxTree } from "@codemirror/language";
import { languages as codeLanguages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { authorKey, type Change, type FilePath } from "../../../worker/src/files.ts";
import { leverInstant, type Levers, type LeversPage } from "../../../worker/src/levers.ts";
import { parseGrants } from "../../../worker/src/permissions.ts";
import type { Settings } from "../../../worker/src/settings.ts";
import type { CommandBar } from "../commandbar.ts";
import { editorFile } from "../embeds.ts";
import type { Commands } from "../commands.ts";
import type { ExtensionRuntime } from "../extension-runtime.ts";
import * as L from "../layout.ts";
import type { Offline } from "../offline.ts";
import { webviews } from "../sandbox.ts";
import type { Workbench } from "../workbench.ts";
import { layoutFill, lineShift, overlaps } from "./checks.ts";
import { advanceClock, clockNow, setClock } from "./clock.ts";
import { parseKeys, type KeyPress } from "./key-notation.ts";
import { net } from "./net.ts";
import type { LayoutShift, Problem, PromptRecord } from "./index.ts";

/** The parts of the app the inspector reads, handed over by main.ts. */
export interface DevApp {
  workbench: Workbench;
  extensions: ExtensionRuntime;
  commands: Commands;
  bar: CommandBar;
  offline: Offline;
  settings(): Settings;
}

interface Kept {
  page: LeversPage;
  levers: Levers;
  set(changes: Partial<Record<keyof Levers, string | boolean | null>>): Levers;
  prompts: PromptRecord[];
  problems: Problem[];
  shifts: LayoutShift[];
  reset(scenario?: string): Promise<void>;
}

const IS_MAC = navigator.platform.startsWith("Mac");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The CodeMirror editor an element is in, if it's in one. */
function editorOf(el: Element | null): EditorView | null {
  const dom = el?.closest<HTMLElement>(".cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
}

function vimOf(view: EditorView | null) {
  const cm = view && getCM(view);
  const vim = (cm as unknown as { state?: { vim?: Record<string, unknown> & { inputState?: Record<string, unknown> } } } | null)?.state?.vim;
  if (!vim) return null;
  const mode = vim.insertMode ? "insert" : vim.visualBlock ? "visual block" : vim.visualLine ? "visual line" : vim.visualMode ? "visual" : "normal";
  const input = vim.inputState ?? {};
  const pending = [input.prefixRepeat, input.operator ? String(input.operator) : "", input.motionRepeat, input.keyBuffer].flat().filter(Boolean).join("");
  return { mode, pending };
}

/** Legacy key codes, which some code still reads (Vim's prompt takes Enter as keyCode 13). */
const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222,
};
const keyCode = (key: string) => KEY_CODES[key] ?? (/^F(\d+)$/.test(key) ? 111 + Number(key.slice(1)) : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);

/** Press a key as the browser would: keydown (which the app and Vim take), the text it types if nothing took it, then keyup. */
function press(k: KeyPress, view: EditorView | null): void {
  const active = document.activeElement;
  const target = active && active !== document.body ? active : (view?.contentDOM ?? document.body);
  const init: KeyboardEventInit = { key: k.key, code: k.key.length === 1 ? `Key${k.key.toUpperCase()}` : k.key, ctrlKey: k.ctrl, altKey: k.alt, metaKey: k.meta, shiftKey: k.shift, bubbles: true, cancelable: true, composed: true };
  const event = (type: string) => {
    const e = new KeyboardEvent(type, init);
    const code = type === "keypress" ? k.key.charCodeAt(0) : keyCode(k.key);
    Object.defineProperties(e, { keyCode: { get: () => code }, which: { get: () => code } });
    return e;
  };
  const typed = target.dispatchEvent(event("keydown"));
  if (typed && k.key.length === 1 && !k.ctrl && !k.meta && !k.alt) {
    target.dispatchEvent(event("keypress"));
    document.execCommand("insertText", false, k.key);
  }
  target.dispatchEvent(event("keyup"));
}

export function makeInspector(app: DevApp, kept: Kept) {
  const { workbench, extensions, offline } = app;
  const focusedEditor = () => editorOf(document.activeElement) ?? workbench.focusedView;

  const embeds = () =>
    [...document.querySelectorAll<HTMLElement>(".cm-embed")].map((el) => {
      const frame = el.querySelector<HTMLIFrameElement>("iframe");
      const webview = frame ? webviews.get(frame) : undefined;
      const state = el.querySelector(".cm-embed-stopped")
        ? "stopped"
        : el.classList.contains("cm-embed-missing") || el.querySelector(".draw-error")
          ? "error"
          : el.querySelector(".cm-embed-loading")
            ? "loading"
            : el.childElementCount
              ? "drawn"
              : "empty";
      return {
        kind: el.classList.contains("cm-url-embed") ? "url" : "block",
        language: el.dataset.embed ?? el.dataset.urlEmbed ?? "",
        note: editorOf(el)?.state.facet(editorFile) ?? null,
        shown: el.offsetParent !== null,
        state,
        text: state === "error" ? (el.textContent ?? "").trim() : undefined,
        frame: frame ? { src: frame.src.replace(location.origin, ""), width: frame.clientWidth, height: frame.clientHeight } : undefined,
        webview: webview?.status,
      };
    });

  const inspector = {
    scenario: kept.page.scenario,
    levers: {
      get: () => ({ ...kept.levers }),
      /** Change levers now: { now: "2026-10-05T09:00" | "real" | null, permissions, net, offline }. Null clears one. */
      set: kept.set,
    },
    clock: {
      now: () => new Date(clockNow()).toISOString(),
      set: (when: string) => setClock(when, leverInstant(when), true),
      advance: (ms: number) => advanceClock(ms),
    },

    /** Everything at once, as plain data. */
    async state() {
      const view = focusedEditor();
      const sel = view?.state.selection.main;
      const line = view && sel ? view.state.doc.lineAt(sel.head) : null;
      const settings = app.settings();
      const groups = L.groups(workbench.layout);
      const els = [...document.querySelectorAll<HTMLElement>("#workbench section.group")];
      const history = await fetch("/api/history?limit=15")
        .then((r) => (r.ok ? (r.json() as Promise<Change[]>) : []))
        .catch(() => []);
      return {
        scenario: kept.page.scenario,
        levers: { ...kept.levers },
        clock: new Date(clockNow()).toISOString(),
        focus: { path: workbench.focusedPath, window: workbench.layout.focus, element: describe(document.activeElement) },
        cursor:
          view && sel && line
            ? { line: line.number, column: sel.head - line.from + 1, head: sel.head, anchor: sel.anchor, text: line.text, lines: view.state.doc.lines }
            : null,
        vim: vimOf(view),
        layout: workbench.layout,
        windows: groups.map((g, i) => {
          const r = els[i]?.getBoundingClientRect();
          return { id: g.id, focused: g.id === workbench.layout.focus, rect: r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, tabs: workbench.tabs(g.id) };
        }),
        pending: workbench.pending(),
        save: { status: document.getElementById("save")?.dataset.status ?? "", text: document.getElementById("save")?.textContent ?? "" },
        network: { online: offline.online && !net.offline, socket: socketState(), inFlight: net.inFlight, unsent: await offline.unsent() },
        extensions: extensions.host.records.map((r) => ({
          id: r.id,
          name: r.manifest.name,
          state: r.state,
          tier: r.tier,
          builtIn: !!r.builtIn,
          workspace: !!r.workspace,
          trusted: settings["extensions.trusted"].includes(r.id),
          ...(r.error ? { error: r.error } : {}),
        })),
        permissions: { grants: parseGrants(settings["extensions.permissions"]), prompts: kept.prompts },
        activity: extensions.broker.log.slice(0, 30),
        history: history.map((c) => ({ revision: c.revision, path: c.path, author: authorKey(c.author), time: new Date(c.time).toISOString(), ...(c.undoes ? { undoes: c.undoes } : {}) })),
        problems: kept.problems,
        embeds: embeds(),
        layoutShifts: kept.shifts.slice(-50),
        notices: [...document.querySelectorAll(".notice p")].map((p) => p.textContent ?? ""),
        dialogs: [...document.querySelectorAll(".dialog h2, dialog h2")].map((h) => h.textContent ?? ""),
      };
    },

    /**
     * Code languages and parsing: which of language-data's languages have loaded (each is a chunk
     * fetched the first time a block names it), and how far the focused editor's syntax tree reaches.
     */
    parsing() {
      const view = focusedEditor();
      return {
        loaded: codeLanguages.filter((l) => l.support).map((l) => l.name),
        parsedTo: view ? syntaxTree(view.state).length : 0,
        length: view?.state.doc.length ?? 0,
        running: view ? syntaxParserRunning(view) : false,
      };
    },

    /** Where the cursor is, cheaply: the focused note, line and column (1-based), and Vim's mode. */
    where() {
      const view = focusedEditor();
      if (!view) return null;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { path: workbench.focusedPath, line: line.number, column: head - line.from + 1, lines: view.state.doc.lines, mode: vimOf(view)?.mode ?? null };
    },

    /** Press keys in Vim's notation ("jj>>", ":vs<CR>", "<C-w>l") where focus is, as the keyboard would. */
    async keys(seq: string) {
      for (const k of parseKeys(seq, IS_MAC)) {
        press(k, focusedEditor());
        await tick();
      }
    },

    /** Put the cursor in the focused editor at a line (1-based) and column, without a click. */
    cursor(line: number, column = 1) {
      const view = workbench.focusedView;
      if (!view) throw new Error("No note has focus");
      const l = view.state.doc.line(line);
      view.dispatch({ selection: { anchor: Math.min(l.from + column - 1, l.to) }, scrollIntoView: true });
      view.focus();
    },

    /** Open a note by path or by name ("Chores"), as quick open does. */
    async open(note: string) {
      const path = (/\.(md|json)$/.test(note) ? note : `${note}.md`) as FilePath;
      await workbench.open(path);
      workbench.focus();
    },

    /** Run a command by its title or id. */
    command(name: string) {
      const c = app.commands.all().find((x) => x.id === name || x.title.toLowerCase() === name.toLowerCase());
      if (!c) throw new Error(`No command ${name}`);
      return app.commands.run(c.id);
    },

    /**
     * Wait until the app settles: no requests in flight, every open note saved and the layout too, the
     * live socket open (unless offline), no extension mid-request, and nothing of that for `quiet` ms.
     */
    async idle({ timeout = 10_000, quiet = 300 } = {}) {
      const started = performance.now();
      let calm = 0;
      for (;;) {
        const busy = waiting();
        if (busy.length) calm = 0;
        else calm ||= performance.now();
        if (calm && performance.now() - calm >= quiet && performance.now() - net.lastActivity >= quiet) return { waitedMs: Math.round(performance.now() - started) };
        if (performance.now() - started > timeout) throw new Error(`Not idle after ${timeout}ms: ${busy.join("; ") || "requests kept coming"}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },

    /**
     * Hold back the page's requests that match `pattern` (against "METHOD /path?query", such as
     * "PUT /api/file") by `ms`, to open the window a race needs. With no pattern, hold none back.
     */
    slow(pattern?: string, ms = 1000) {
      net.slow = pattern ? [...net.slow, { match: new RegExp(pattern), ms }] : [];
    },

    /** Reset the workspace to a scenario, by default the one it holds, and start the page over. */
    reset: (scenario = kept.page.scenario || undefined) => kept.reset(scenario),

    /** The geometry checks: each answers with the problems it finds. */
    check: {
      overlaps: () => overlaps(),
      lineShift: (lines?: number[]) => {
        const view = workbench.focusedView;
        if (!view) throw new Error("No note has focus");
        return lineShift(view, lines);
      },
      layoutFill: () => layoutFill(workbench.layout, document.getElementById("workbench")!),
      layoutShifts: (since = 0) => kept.shifts.filter((s) => s.time >= since),
    },

    embeds: {
      list: embeds,
      /** What each webview on the page shows now: frames, draw calls, and how much of each canvas is drawn on. */
      probe: () =>
        Promise.all(
          [...document.querySelectorAll<HTMLIFrameElement>("iframe.webview")].map(async (f) => {
            const w = webviews.get(f);
            return { title: f.title, ...(w ? await w.probe().catch((e: Error) => ({ error: e.message })) : { error: "not a webview" }) };
          }),
        ),
    },
  };

  function waiting(): string[] {
    const busy: string[] = [];
    if (net.inFlight) busy.push(`${net.inFlight} request${net.inFlight === 1 ? "" : "s"} in flight`);
    // A conflict waits for you, and an unsent edit for the network: neither moves on its own.
    for (const p of workbench.pending()) if (p.status !== "conflict" && !(p.status === "offline" && net.offline)) busy.push(`${p.path} ${p.status}`);
    if (!net.offline && socketState() !== "open") busy.push(`live socket ${socketState()}`);
    const reaching = extensions.broker.busy();
    if (reaching.length) busy.push(`${reaching.join(", ")} reaching the network`);
    return busy;
  }

  return inspector;
}

function socketState(): string {
  const ws = net.live;
  if (!ws) return "none";
  if (!(ws instanceof WebSocket)) return "held";
  return ["connecting", "open", "closing", "closed"][ws.readyState];
}

function describe(el: Element | null): string {
  if (!el || el === document.body) return "body";
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
