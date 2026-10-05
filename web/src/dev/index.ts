// Test levers in the page (docs/TESTING.md), loaded only when the Worker says this page has them. boot()
// runs before the app does: it sets the levers from the address and their cookie, moves the clock,
// watches the network and catches errors. install() runs once the app is up, and puts the inspector at
// window.__commonInk, the levers' commands in the command bar, and a status bar note while one is set.
import { leverInstant, leverParams, leversCookie, leversFromCookie, readLevers, type Levers, type LeversPage } from "../../../worker/src/levers.ts";
import type { ExtensionManifest } from "../../../worker/src/extensions.ts";
import type { Ask } from "../../../worker/src/permissions.ts";
import type { Choice } from "../broker.ts";
import { reportInvariants } from "../invariants.ts";
import { installClock, setClock } from "./clock.ts";
import { installNet, setOffline } from "./net.ts";
import { makeInspector, type DevApp } from "./inspector.ts";

export type Prompt = (extension: ExtensionManifest, asks: Array<{ ask: Ask; key: string }>, joined: (fn: (ask: { ask: Ask; key: string }) => void) => void) => Promise<Choice>;

/** A prompt as the inspector reports it: who asked for what, whether a lever answered, and the answer once there is one. */
export interface PromptRecord {
  time: number;
  extension: string;
  asks: string[];
  auto: boolean;
  answer: Choice | null;
}

/** What went wrong in the page: errors thrown or logged, and invariants that didn't hold. */
export interface Problem {
  time: number;
  kind: "error" | "rejection" | "console" | "invariant";
  message: string;
}

/** One layout shift the browser saw, with each element that moved and by how much (dx, dy in px). */
export interface LayoutShift {
  time: number;
  value: number;
  hadRecentInput: boolean;
  moved: Array<{ node: string; dx: number; dy: number }>;
}

export function boot(page: LeversPage) {
  const levers: Levers = readLevers(new URLSearchParams(location.search), leversFromCookie(document.cookie));
  const prompts: PromptRecord[] = [];
  const problems: Problem[] = [];
  const shifts: LayoutShift[] = [];
  const keep = <T>(list: T[], item: T, max = 200) => {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  };

  const broke = (name: string, found: string[]) => {
    for (const message of found) keep(problems, { time: Date.now(), kind: "invariant", message: `${name}: ${message}` });
    console.error(`Invariant broken (${name}): ${found.join("; ")}`);
  };
  const apply = () => {
    document.cookie = leversCookie(levers);
    const now = levers.now ?? page.now ?? "real";
    setClock(now, leverInstant(now));
    setOffline(!!levers.offline);
  };
  installClock();
  installNet({ reset: () => void clearAndReload(), broken: broke });
  apply();
  reportInvariants(broke);
  addEventListener("error", (e) => keep(problems, { time: Date.now(), kind: "error", message: e.message || String(e.error) }));
  addEventListener("unhandledrejection", (e) => keep(problems, { time: Date.now(), kind: "rejection", message: e.reason instanceof Error ? e.reason.message : String(e.reason) }));
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).startsWith("Invariant broken")) keep(problems, { time: Date.now(), kind: "console", message: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ") });
    consoleError(...args);
  };
  try {
    type Source = { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Source[] }>) {
        const moved = (e.sources ?? []).map((s) => ({
          node: s.node instanceof Element ? `${s.node.tagName.toLowerCase()}${s.node.className ? `.${String(s.node.className).trim().split(/\s+/).join(".")}` : ""}` : (s.node?.nodeName ?? "(gone)"),
          dx: Math.round(s.currentRect.x - s.previousRect.x),
          dy: Math.round(s.currentRect.y - s.previousRect.y),
        }));
        keep(shifts, { time: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput, moved });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  return {
    levers,
    /** Permission prompts, answered by the `permissions` lever when it says so, and recorded either way. */
    prompt(real: Prompt): Prompt {
      return async (extension, asks, joined) => {
        const record: PromptRecord = { time: Date.now(), extension: extension.id, asks: asks.map((a) => a.key), auto: levers.permissions === "allow" || levers.permissions === "deny", answer: null };
        keep(prompts, record);
        // Allow once and Escape keep nothing in settings, so a lever's answers last only as long as the page.
        record.answer =
          levers.permissions === "allow"
            ? "once"
            : levers.permissions === "deny"
              ? "dismiss"
              : await real(extension, asks, (fn) =>
                  joined((a) => {
                    record.asks.push(a.key);
                    fn(a);
                  }),
                );
        return record.answer;
      };
    },
    /** The app is up: the inspector, the levers' commands, and the status bar note. */
    install(app: DevApp) {
      const set = (changes: Partial<Record<keyof Levers, string | boolean | null>>) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(changes)) params.set(k, v === null ? "" : typeof v === "boolean" ? (v ? "1" : "0") : v);
        const next = readLevers(params, levers);
        for (const k of Object.keys(levers) as Array<keyof Levers>) delete levers[k];
        Object.assign(levers, next);
        apply();
        note();
        return { ...levers };
      };
      const inspector = makeInspector(app, { page, levers, set, prompts, problems, shifts, reset });
      Object.defineProperty(window, "__commonInk", { value: inspector, configurable: true });
      const status = document.createElement("button");
      status.className = "status-item levers-note";
      status.addEventListener("click", () => app.commands.run("levers.show"));
      document.getElementById("status-right")?.append(status);
      const note = () => {
        const params = leverParams({ ...levers, now: levers.now ?? page.now });
        status.textContent = [...params].map(([k, v]) => (k === "now" ? v.replace("T", " ") : k === "offline" ? (v === "1" ? "offline" : "") : `${k} ${v}`)).filter(Boolean).join(" · ");
        status.hidden = !status.textContent;
        status.title = `Test levers (docs/TESTING.md). Scenario: ${page.scenario || "none"}. Change them in the address: ?${params}`;
      };
      note();
      app.commands.register(
        { id: "levers.show", title: "Test levers: Copy the inspector's state as JSON", run: async () => navigator.clipboard.writeText(JSON.stringify(await inspector.state(), null, 2)) },
        { id: "levers.reset", title: "Test levers: Reset the workspace to its scenario", run: () => reset(page.scenario || undefined) },
        {
          id: "levers.resetTo",
          title: "Test levers: Reset the workspace to a scenario…",
          run: async () => {
            const { scenarios } = (await (await fetch("/api/levers")).json()) as { scenarios: Array<{ name: string; about: string }> };
            app.bar.pick("Reset the workspace to a scenario", scenarios.map((s) => ({ label: s.name, detail: s.about, run: () => reset(s.name) })));
          },
        },
        { id: "levers.offline", title: "Test levers: Go offline, or back online", run: () => set({ offline: !levers.offline }) },
      );
    },
  };

  /** Reset the workspace to a scenario (or the deploy's own seed), then start this page over. */
  async function reset(scenario?: string): Promise<void> {
    const res = await fetch("/api/levers/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scenario ? { scenario } : {}) });
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Reset answered ${res.status}`);
    await clearAndReload();
  }
}

/** Forget what this page kept of the old workspace (its copy of every file, and unsent edits), then load again. */
async function clearAndReload(): Promise<void> {
  await new Promise<void>((resolve) => {
    const open = indexedDB.open("common-ink");
    open.onsuccess = () => {
      const db = open.result;
      const stores = [...db.objectStoreNames];
      if (!stores.length) return resolve();
      const tx = db.transaction(stores, "readwrite");
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = tx.onerror = () => (db.close(), resolve());
    };
    open.onerror = () => resolve();
  });
  try {
    sessionStorage.clear();
  } catch {}
  location.assign(`${location.pathname}${location.search}`);
}
