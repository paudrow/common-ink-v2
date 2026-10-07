// Page objects for browser tests: the app as a person and its inspector see it, so a test says what it
// does ("open Chores, press jj>>") rather than how to find it in the page. Keys go through a real
// keyboard; state comes from window.__commonInk (docs/TESTING.md).
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { parseKeys, playwrightKey } from "../../web/src/dev/key-notation.ts";

type Inspector = Record<string, (...args: unknown[]) => unknown> & { check: Record<string, (...args: unknown[]) => unknown>; embeds: Record<string, () => unknown> };

/** What the inspector's state() says. Only the parts tests read are typed. */
export interface AppState {
  scenario: string;
  clock: string;
  focus: { path: string | null; window: string; element: string };
  cursor: { line: number; column: number; text: string; lines: number } | null;
  vim: { mode: string; pending: string } | null;
  layout: { root: unknown; focus: string };
  windows: Array<{ id: string; focused: boolean; rect: { x: number; y: number; width: number; height: number }; tabs: Array<{ label: string; selected: boolean; preview: boolean; status?: string }> }>;
  pending: Array<{ path: string; status: string }>;
  network: { online: boolean; unsent: Array<{ path: string }> };
  extensions: Array<{ id: string; name: string; state: string; error?: string }>;
  permissions: { grants: Record<string, Record<string, string>>; prompts: Array<{ extension: string; asks: string[]; auto: boolean; answer: string | null }> };
  embeds: Array<{ kind: string; language: string; note: string | null; shown: boolean; state: string; webview?: { loaded: boolean; drawn: { webgl: number; "2d": number } } }>;
  history: Array<{ revision: number; path: string; author: string }>;
  problems: Array<{ kind: string; message: string }>;
  layoutShifts: Array<{ time: number; value: number; hadRecentInput: boolean; moved: Array<{ node: string; dx: number; dy: number }> }>;
  dialogs: string[];
  notices: string[];
}

/** `work`, or a failure that names `what` after `ms`: page.evaluate has no timeout of its own. */
export function bounded<T>(what: string, work: Promise<T>, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} didn't return in ${ms / 1000} s`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class App {
  readonly editor = new Editor(this);
  readonly tabs = new Tabs(this);
  readonly settings = new SettingsEditor(this);
  readonly extensions = new ExtensionsView(this);
  readonly prompt = new PermissionPrompt(this);
  readonly embeds = new Embeds(this);

  constructor(
    readonly page: Page,
    readonly base: string,
  ) {}

  /** Call the inspector: `call("idle")`, `call("check.overlaps")`. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return bounded(`__commonInk.${name}()`, this.page.evaluate(
      ([name, args]) => {
        const [first, second] = (name as string).split(".");
        const ci = (window as unknown as { __commonInk: Inspector }).__commonInk;
        const target = second ? (ci[first] as unknown as Record<string, (...a: unknown[]) => unknown>) : ci;
        return target[second ?? first](...(args as unknown[]));
      },
      [name, args] as const,
    ) as Promise<T>);
  }

  /** Empty the workspace and fill it from a scenario, as the levers' reset does. */
  async reset(scenario: string) {
    const res = await this.page.context().request.post(`${this.base}/api/levers/reset`, { data: { scenario } });
    assert.ok(res.ok(), `reset to ${scenario}: ${res.status()} ${await res.text()}`);
  }

  /** Load the app with these levers in its address, wait for it to start, and open a note if asked. */
  async goto(levers: Record<string, string> = {}, open?: string) {
    const params = new URLSearchParams(levers);
    await this.navigate(() => this.page.goto(`${this.base}/${params.size ? `?${params}` : ""}`));
    if (open) await this.open(open);
  }

  /** Wait for the app on show to have started: the levers' window.__commonInk is set once it has. */
  async ready() {
    await this.page.waitForFunction(() => !!(window as unknown as { __commonInk?: unknown }).__commonInk && document.readyState === "complete");
  }

  async reload() {
    await this.navigate(() => this.page.reload());
  }

  /**
   * Go somewhere (a reload, back or forward, an address), then wait for the app there to have started.
   * The page before is marked first, so what's waited for is the new page, not the one being left: a
   * navigation can settle before the new page has run anything.
   */
  async navigate(go: () => Promise<unknown>) {
    await this.page.evaluate(() => ((window as unknown as { __leaving?: true }).__leaving = true)).catch(() => {});
    await go();
    await this.page.waitForFunction(() => !(window as unknown as { __leaving?: true }).__leaving);
    await this.ready();
  }

  state(): Promise<AppState> {
    return this.call("state");
  }

  /** Wait for saves, the live socket and extensions' requests to settle. */
  idle(): Promise<unknown> {
    return this.call("idle");
  }

  async open(note: string) {
    await this.call("open", note);
    await this.page.waitForFunction((name) => document.title.startsWith(name.replace(/\.md$/, "")), note);
  }

  /** Run a command by its title, as the command bar would. */
  command(title: string) {
    return this.call("command", title);
  }

  /** Press keys in Vim's notation on the real keyboard: "jj>>", ":vs<CR>", "<C-w>l". */
  async keys(seq: string) {
    for (const k of parseKeys(seq, process.platform === "darwin")) await this.page.keyboard.press(playwrightKey(k));
  }

  /**
   * Wait for a code language's chunk to load, and bring the first block on screen. CodeMirror draws
   * only the lines near the screen, so a block below it has no highlighted text to find.
   */
  async codeShown(language: string) {
    await this.page.waitForFunction((l) => (window as unknown as { __commonInk: { parsing(): { loaded: string[] } } }).__commonInk.parsing().loaded.includes(l), language);
    await bounded("codeShown's scroll", this.page.evaluate(() => document.querySelector(".tab-editor:not([hidden]) .cm-code-header")?.scrollIntoView({ block: "start" })));
  }

  async readFile(path: string): Promise<string> {
    const res = await this.page.context().request.get(`${this.base}/api/file?path=${encodeURIComponent(path)}`);
    return res.ok() ? ((await res.json()) as { text: string }).text : "";
  }

  async writeFile(path: string, text: string) {
    const request = this.page.context().request;
    const current = await request.get(`${this.base}/api/file?path=${encodeURIComponent(path)}`);
    const base = current.ok() ? ((await current.json()) as { revision: number }).revision : 0;
    const res = await request.put(`${this.base}/api/file`, { data: { path, text, base } });
    assert.ok(res.ok(), `write ${path}: ${res.status()}`);
  }
}

class Part {
  constructor(protected app: App) {}
  protected get page() {
    return this.app.page;
  }
}

/** The focused note's editor, with Vim. */
export class Editor extends Part {
  async focus() {
    await this.page.locator(".group .tab-editor:not([hidden]) .cm-content").first().focus();
  }
  keys(seq: string) {
    return this.app.keys(seq);
  }
  async cursor() {
    return (await this.app.state()).cursor;
  }
  async mode() {
    return (await this.app.state()).vim?.mode ?? null;
  }
  /** Put the cursor on a line (1-based), without the mouse. */
  async at(line: number, column = 1) {
    await this.app.call("cursor", line, column);
  }
}

/** Windows and their tabs. */
export class Tabs extends Part {
  async windows() {
    return (await this.app.state()).windows;
  }
  /** A tab in a window (0-based, left to right and top to bottom), by its label. */
  tab(window: number, label: string): Locator {
    return this.page.locator("section.group").nth(window).locator(".tab", { hasText: label });
  }
  async selected(window = 0): Promise<string | undefined> {
    return (await this.windows())[window]?.tabs.find((t) => t.selected)?.label;
  }
}

/** The settings editor's User | Workspace switch and its values. */
export class SettingsEditor extends Part {
  async open(level: "user" | "workspace") {
    await this.app.command(level === "user" ? "Open user settings" : "Open workspace settings");
    await this.page.waitForSelector(".settings-editor");
  }
  /** Which level the switch shows. */
  async level(): Promise<string> {
    return (await this.page.locator('.settings-editor .levels [aria-selected="true"]').textContent()) ?? "";
  }
  async switchTo(level: "User" | "Workspace") {
    await this.page.locator(".settings-editor .levels [role=tab]", { hasText: level }).click();
    await this.page.waitForFunction((level) => document.querySelector('.settings-editor .levels [aria-selected="true"]')?.textContent?.startsWith(level), level);
  }
  /** The control for a setting key, to read or change. */
  control(key: string): Locator {
    return this.page.locator(".settings-editor .setting", { has: this.page.locator(".setting-key", { hasText: key }) });
  }
}

/** The Extensions view and each extension's state, as the inspector reports it. */
export class ExtensionsView extends Part {
  async show() {
    await this.app.command("Show extensions");
    // In the panel, or, on a phone (the shell), in the window, where panels open there.
    await this.page.locator("#panel .extensions-view, #workbench .extensions-view").first().waitFor();
  }
  row(id: string): Locator {
    return this.page.locator(`.extension-row[data-extension="${id}"]`);
  }
  async state(id: string) {
    return (await this.app.state()).extensions.find((e) => e.id === id);
  }
}

/** Permission prompts: the dialog on screen, and every prompt the page has shown. */
export class PermissionPrompt extends Part {
  dialog(): Locator {
    return this.page.locator(".dialog", { has: this.page.locator(".dialog-asks") });
  }
  async waitFor() {
    await this.dialog().waitFor();
  }
  async answer(choice: "Allow once" | "Always allow" | "Don't allow") {
    await this.dialog().getByRole("button", { name: choice }).click();
    await this.dialog().waitFor({ state: "detached" });
  }
  async shown() {
    return (await this.app.state()).permissions.prompts;
  }
}

/** Embeds in notes, and what their webviews have drawn. */
export class Embeds extends Part {
  async list() {
    return (await this.app.state()).embeds;
  }
  probe() {
    return this.app.call<Array<{ title: string; frames: number; drawn: { webgl: number; "2d": number }; canvases: Array<{ kind: string; filled: number; colors: number }> }>>("embeds.probe");
  }
}
