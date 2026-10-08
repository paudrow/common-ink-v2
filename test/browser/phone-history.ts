// The phone shell's one rule for history (shell.ts, reconcile): the entry you're on says what's on show,
// and going back to an entry (or reloading on it) shows exactly what it says.
// Random walks over what a person does on a phone (the bottom bar, Places, Search, a note in the list, a
// link, the sheets, ‹, the system's back, quick backs, and reloads), seeded so a failure can be run again
// alone. After each step: the entry describes the screen, and a back pushed nothing. At the end: back
// always changes the screen, until it leaves the app.
import assert from "node:assert/strict";
import { browserTest, type harness } from "./harness.ts";
import type { App } from "./pages.ts";

/** A small seeded generator (mulberry32), so a walk is the same every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What's on show, and what the entry says. */
export const look = (app: App) =>
  app.page.evaluate(() => {
    const ci = (window as unknown as { __commonInk: { state(): Promise<{ layout: { focus: string; root: unknown } }> } }).__commonInk;
    return ci.state().then((s) => {
      type N = { kind: "group"; id: string; tabs: Array<{ file?: string; view?: string }>; active: number } | { kind: "split"; children: N[] };
      const groups: Array<Extract<N, { kind: "group" }>> = [];
      const walk = (n: N) => (n.kind === "group" ? groups.push(n) : n.children.forEach(walk));
      walk(s.layout.root as N);
      const g = groups.find((x) => x.id === s.layout.focus)!;
      const tab = g.tabs[g.active];
      const screen = document.documentElement.dataset.screen;
      const entry = history.state as { place?: string; show?: string } | null;
      return {
        show: screen === "list" ? "list" : tab ? (tab.file ? `file:${tab.file}` : `view:${tab.view}`) : "list",
        entry: entry && typeof entry.show === "string" ? entry.show : null,
        title: document.querySelector("#shell-top h1")?.textContent ?? "",
        length: history.length,
      };
    });
  });

/** The entry says what's on show, once the page has settled (history is reconciled a moment after). */
export async function agrees(app: App, step: string) {
  let seen = await look(app);
  for (let i = 0; i < 30 && seen.entry !== seen.show; i++) {
    await app.page.waitForTimeout(100);
    seen = await look(app);
  }
  assert.equal(seen.entry, seen.show, `after ${step}: the entry says ${seen.entry}, the screen shows ${seen.show} (${seen.title})`);
  return seen;
}

export const inApp = (app: App) => app.page.url().startsWith(app.base);

/** A step that goes back: it moves through the history the browser has, and adds nothing to it. */
type Step = { name: string; back?: true; can(app: App): Promise<boolean>; run(app: App): Promise<void> };

export const tap = (app: App, selector: string) => app.page.locator(selector).first().tap();
export const settle = (app: App) => app.page.waitForTimeout(350);

/** Back `n` times, `gap` ms apart, then back into the app if that left it; with `slow`, every server answer takes 1.2s. */
export async function backs(app: App, n: number, gap: number, slow = false) {
  if (slow) await app.page.route(/\/api\//, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue().catch(() => null);
  });
  await app.page.evaluate(([n, gap]) => {
    for (let i = 0; i < n; i++) setTimeout(() => history.back(), i * gap);
  }, [n, gap] as const);
  await app.page.waitForTimeout(slow ? 4000 : n * gap + 600);
  if (slow) await app.page.unroute(/\/api\//);
  if (!inApp(app)) {
    await app.navigate(() => app.page.goForward());
  }
}

const STEPS: Step[] = [
  ...["Feed", "Today", "Calendar"].map((p) => ({ name: `tap ${p}`, can: async () => true, run: (app: App) => tap(app, `#shell-bar [aria-label="${p}"]`) })),
  ...["Tasks", "Settings", "Feed"].map((p) => ({
    name: `Places › ${p}`,
    can: async () => true,
    run: async (app: App) => {
      await tap(app, '#shell-bar [aria-label="Places"]');
      await app.page.locator(".shell-sheet .shell-place", { hasText: new RegExp(`^${p}$`) }).first().tap();
    },
  })),
  {
    name: "Search › Lists tour",
    can: async () => true,
    run: async (app) => {
      await tap(app, '#shell-bar [aria-label="Search"]');
      await app.page.locator("#command-bar:not([hidden]) input").waitFor();
      await app.page.keyboard.insertText("Basil");
      // The search's own hit: until it answers, the list is still the empty query's (Recent, which has
      // Lists tour too), and a tap on that as it's drawn again can land on nothing.
      await app.page.locator("#command-bar-items:not([aria-busy])").waitFor();
      const hit = app.page.locator("#command-bar li", { hasText: "Lists tour" }).filter({ hasText: "Basil" }).first();
      await hit.waitFor();
      await hit.tap();
    },
  },
  {
    name: "a note in the list",
    can: async (app) => (await app.page.locator("#notes a").count()) > 0 && (await app.page.locator("#notes").isVisible()),
    run: async (app) => tap(app, "#notes a"),
  },
  { name: "‹", can: async (app) => (await app.page.locator('#shell-top [aria-label^="Back to"]').count()) > 0, run: (app) => tap(app, '#shell-top [aria-label^="Back to"]') },
  ...["Trash", "Archive", "Contacts", "Extensions"].map((p) => ({
    name: `Places › ${p}`,
    can: async () => true,
    run: async (app: App) => {
      await tap(app, '#shell-bar [aria-label="Places"]');
      await app.page.locator(".shell-sheet .shell-place", { hasText: new RegExp(`^${p}`) }).first().tap();
    },
  })),
  {
    name: "◷ History sheet, closed",
    can: async (app) => (await app.page.locator('#shell-top [aria-label="History and views about this note"]').count()) > 0,
    run: async (app) => {
      await tap(app, '#shell-top [aria-label="History and views about this note"]');
      await app.page.locator(".shell-sheet").waitFor();
      await app.page.keyboard.press("Escape");
    },
  },
  {
    name: "Customize › Done",
    can: async () => true,
    run: async (app) => {
      await tap(app, '#shell-bar [aria-label="Places"]');
      await app.page.locator(".shell-sheet .shell-place", { hasText: "Customize" }).tap();
      await app.page.locator(".shell-sheet .shell-primary").tap();
    },
  },
  {
    // History opens in the window, over the note: a view over a place.
    name: "⋯ › Add label, cancelled",
    can: async (app) => (await app.page.locator('#shell-top [aria-label="More"]').count()) > 0,
    run: async (app) => {
      await tap(app, '#shell-top [aria-label="More"]');
      await app.page.locator(".shell-sheet .shell-action", { hasText: "Add label" }).first().tap();
      await app.page.waitForTimeout(200);
      await app.page.keyboard.press("Escape");
    },
  },
  {
    name: "a link in the note",
    can: async (app) => (await app.page.locator("#workbench .cm-wikilink").count()) > 0 && (await app.page.locator("#workbench").isVisible()),
    run: async (app) => app.page.locator("#workbench .cm-wikilink").first().tap(),
  },
  { name: "double back at 0 ms", back: true, can: async () => true, run: (app) => backs(app, 2, 0) },
  { name: "triple back at 0 ms", back: true, can: async () => true, run: (app) => backs(app, 3, 0) },
  { name: "double back 400 ms apart, slow server", back: true, can: async () => true, run: (app) => backs(app, 2, 400, true) },
  {
    name: "system back",
    back: true,
    can: async () => true,
    run: async (app) => {
      await app.page.goBack();
      // Back out of the app is fine; come forward again to go on walking.
      if (!inApp(app)) {
        await app.navigate(() => app.page.goForward());
      }
    },
  },
];

async function walk(app: App, seed: number, reloads: boolean) {
  const next = random(seed);
  const done: string[] = [];
  await agrees(app, "start");
  for (let i = 0; i < 24; i++) {
    const open: Step[] = [];
    for (const s of STEPS) if (await s.can(app)) open.push(s);
    const step = open[Math.floor(next() * open.length)];
    done.push(step.name);
    const length = (await look(app)).length;
    await step.run(app);
    await settle(app);
    const seen = await agrees(app, `seed ${seed}: ${done.join(", ")}`);
    if (step.back) assert.equal(seen.length, length, `seed ${seed}: going back pushed nothing, so forward is kept (${done.join(", ")})`);
    if (reloads) {
      const before = await look(app);
      await app.reload();
      await settle(app);
      const after = await agrees(app, `seed ${seed}: ${done.join(", ")}, reload`);
      assert.equal(after.show, before.show, `seed ${seed}: a reload keeps what was on show (${done.join(", ")})`);
      assert.equal(after.length, before.length, `seed ${seed}: a reload adds no entry (${done.join(", ")})`);
    }
  }
  // Back always changes the screen, until it leaves the app.
  let last = await look(app);
  for (let i = 0; i < 60 && inApp(app); i++) {
    await app.page.goBack();
    await settle(app);
    if (!inApp(app)) break;
    const now = await agrees(app, `seed ${seed}: back ${i + 1} after ${done.join(", ")}`);
    assert.ok(now.show !== last.show || now.title !== last.title, `seed ${seed}: back ${i + 1} showed the same screen again (${now.show}) after ${done.join(", ")}`);
    last = now;
  }
  assert.ok(!inApp(app), `seed ${seed}: back left the app at last`);
}

/** A second note, with a link to the first, for the walks to follow. */
async function linked(app: App) {
  await app.writeFile("Second.md", "# Second\n\nSee [[Lists tour]].\n");
  await app.reload();
}

/** One test per seed, each a walk of 24 steps; with `reloads`, a reload after every step. */
export function randomWalks(h: ReturnType<typeof harness>, seeds: number[], { reloads = false } = {}) {
  for (const seed of seeds) {
    const name = reloads ? `random walk on a phone with a reload after every step, seed ${seed}` : `random walk on a phone, seed ${seed}: the entry always says what's on show, and back always moves`;
    browserTest(h, name, { scenario: "lists", device: "phone" }, async (app) => {
      await linked(app);
      await walk(app, seed, reloads);
    });
  }
}
