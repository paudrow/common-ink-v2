// The app's side of sandboxed extensions (ADR 0006): an extension host for each sandboxed extension,
// a hidden iframe with sandbox="allow-scripts" that lives as long as the page, so a timer keeps going
// when its note closes; and webviews, visible sandboxed iframes an extension draws into. Each talks to
// the app over its own MessagePort, never by window messages anyone could send.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import { leversPage } from "./dev-boot.ts";

/** The app's handling of an extension's call: what it does, after checking manifest and permissions. */
export type Dispatch = (method: string, args: unknown[]) => Promise<unknown>;

type Pending = { resolve(value: unknown): void; reject(err: Error): void };

const hosts = () => {
  let box = document.getElementById("extension-hosts");
  if (!box) {
    box = document.createElement("div");
    box.id = "extension-hosts";
    box.hidden = true;
    document.body.append(box);
  }
  return box;
};

/** The most one call to or answer from a frame may carry, in characters as JSON would write it: twice what a file may hold. */
const MAX_CALL = 2_000_000;
/** What a frame's calls may carry together in a moment, how many there may be, and how long that moment is. */
const SHARE = { size: 10_000_000, calls: 2_000, ms: 10_000 };
/** How deep a value from a frame may nest. */
const MAX_DEPTH = 32;

const counted = (n: number) => n.toLocaleString("en-US");

/** How much longer JSON writes a string than its length: two for its quotes, and its escapes. */
function escapes(s: string): number {
  let extra = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) extra += 1;
    else if (c < 0x20) extra += 5;
  }
  return extra;
}

/**
 * A value from a frame, measured once, as JSON would write it: its size, Infinity as soon as it's past
 * `limit` (without walking the rest), or null if it isn't plain data (text, numbers, booleans, null,
 * and lists and plain objects of them, nested at most 32 deep). A structured clone also keeps String
 * objects, Dates, cycles and the like, which compare unlike the text they'd turn into.
 */
export function measure(v: unknown, limit: number): number | null {
  let size = 0;
  /** False if `x` isn't plain data; true otherwise, or once the size is past the limit. */
  const walk = (x: unknown, depth: number): boolean => {
    if (x === null || x === undefined) size += 4;
    else if (typeof x === "boolean") size += x ? 4 : 5;
    else if (typeof x === "number") size += Number.isFinite(x) ? JSON.stringify(x).length : 4;
    else if (typeof x === "string") size += x.length + (x.length > limit ? 2 : escapes(x));
    else if (typeof x !== "object" || depth >= MAX_DEPTH) return false;
    else if (Array.isArray(x)) {
      // Brackets and commas, and at least a character an item (a hole is "null"): a list too long is too much whatever's in it.
      size += 1 + Math.max(x.length, 1);
      if (size + x.length > limit) return (size = Infinity), true;
      for (let i = 0; i < x.length; i++) {
        if (!(i in x)) size += 4;
        else if (!walk(x[i], depth + 1)) return false;
        if (size > limit) return true;
      }
    } else {
      if (Object.getPrototypeOf(x) !== Object.prototype) return false;
      // JSON leaves out a key whose value is undefined.
      const entries = Object.entries(x).filter(([, item]) => item !== undefined);
      size += 1 + Math.max(entries.length, 1);
      for (const [k, item] of entries) {
        size += k.length + escapes(k) + 1;
        if (!walk(item, depth + 1)) return false;
        if (size > limit) return true;
      }
    }
    return true;
  };
  if (!walk(v, 0)) return null;
  return size > limit ? Infinity : size;
}

/** A frame's share of a moment: what its calls carried and how many there were, kept as a running total. */
export class CallShare {
  private calls: Array<{ at: number; size: number }> = [];
  private first = 0;
  private total = 0;

  constructor(private limits: { size: number; calls: number; ms: number }) {}

  /** Whether a call of `size` fits in what's left of the moment at `now`; if it does, it's counted. */
  take(size: number, now: number): boolean {
    while (this.first < this.calls.length && now - this.calls[this.first].at >= this.limits.ms) this.total -= this.calls[this.first++].size;
    if (this.first > 1024 && this.first * 2 > this.calls.length) [this.calls, this.first] = [this.calls.slice(this.first), 0];
    if (this.calls.length - this.first >= this.limits.calls || this.total + size > this.limits.size) return false;
    this.calls.push({ at: now, size });
    this.total += size;
    return true;
  }

  /** Why a call didn't fit, in words: too many, or too much. */
  why(name: string): string {
    return this.calls.length - this.first >= this.limits.calls
      ? `${name} is calling too often: it can make ${counted(this.limits.calls)} calls every ${this.limits.ms / 1000} seconds`
      : `${name} is sending too much at once: it can send ${counted(this.limits.size)} characters' worth every ${this.limits.ms / 1000} seconds`;
  }
}

/** A frame's MessagePort, once its shell has loaded: the only way the app and the frame talk. */
function connect(frame: HTMLIFrameElement): Promise<MessagePort> {
  return new Promise((resolve) => {
    frame.addEventListener(
      "load",
      () => {
        const channel = new MessageChannel();
        // "*": the frame's origin is opaque, so there's no name to send to. The port is what's private.
        frame.contentWindow!.postMessage({ t: "connect" }, "*", [channel.port2]);
        resolve(channel.port1);
      },
      { once: true },
    );
  });
}

/** One sandboxed extension's host frame, and the calls between it and the app. */
export class SandboxHost {
  private port: MessagePort | null = null;
  private frame: HTMLIFrameElement | null = null;
  private pending = new Map<string, Pending>();
  private next = 0;
  /** Its share of a moment. */
  private share = new CallShare(SHARE);

  constructor(
    private extension: ExtensionManifest,
    private dispatch: Dispatch,
    /** It reported an error after starting: an uncaught exception, say. */
    private failed: (message: string) => void,
  ) {}

  /** Load the frame and start the extension's code from `code`. Resolves once it's activated; rejects with its error. */
  async start(code: string, settings: Record<string, unknown>, me: string | undefined): Promise<void> {
    const frame = (this.frame = document.createElement("iframe"));
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = `${this.extension.name} (extension host)`;
    frame.src = "/sandbox/host";
    const connecting = connect(frame);
    hosts().append(frame);
    const port = (this.port = await connecting);
    // Any later load means the frame navigated: the app's frame-src blocks leaving the sandbox route,
    // so it's on an error page now. Say so, and stop it.
    frame.addEventListener("load", () => {
      this.failed("It tried to navigate its frame away from the sandbox, so it was stopped.");
      this.stop();
    });
    const started = new Promise<void>((resolve, reject) => {
      port.onmessage = (e) => {
        const m = e.data as { t: string; id?: string; method?: string; args?: unknown[]; value?: unknown; message?: string };
        if (m.t === "ready") resolve();
        else if (m.t === "failed") reject(new Error(m.message));
        else if (m.t === "error") this.failed(m.message ?? "Unknown error");
        else if (m.t === "call") void this.answer(m.id!, m.method!, m.args ?? []);
        else if (m.t === "result" || m.t === "reject") {
          const p = this.pending.get(m.id!);
          this.pending.delete(m.id!);
          const size = m.t === "result" ? measure(m.value, MAX_CALL) : 0;
          if (size === null) p?.reject(new Error(`${this.extension.name} can answer only with plain values (text, numbers, lists and objects)`));
          else if (size > MAX_CALL) p?.reject(new Error(`${this.extension.name} answered with more than ${counted(MAX_CALL)} characters' worth`));
          else if (m.t === "result") p?.resolve(m.value);
          else p?.reject(new Error(m.message));
        }
      };
    });
    port.postMessage({ t: "start", extension: this.extension, code, settings, me });
    await started;
  }

  private async answer(id: string, method: string, args: unknown[]) {
    try {
      const size = typeof method === "string" && Array.isArray(args) ? measure(args, MAX_CALL) : null;
      if (size === null) throw new Error(`${this.extension.name} can pass only plain values (text, numbers, lists and objects)`);
      if (size > MAX_CALL) throw new Error(`${this.extension.name} sent more than ${counted(MAX_CALL)} characters' worth in one call`);
      if (!this.share.take(size, Date.now())) throw new Error(this.share.why(this.extension.name));
      this.port!.postMessage({ t: "result", id, value: (await this.dispatch(method, args)) ?? null });
    } catch (err) {
      this.port!.postMessage({ t: "reject", id, message: (err as Error).message });
    }
  }

  /** Run one of the extension's handlers (a command, a view, a command bar provider) and get its answer. */
  invoke(handler: string, ...args: unknown[]): Promise<unknown> {
    if (!this.port) return Promise.reject(new Error(`${this.extension.name} isn't running`));
    const id = `a${++this.next}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port!.postMessage({ t: "invoke", id, handler, args });
    });
  }

  /** Tell the extension something happened: a file saved, focus moved, settings changed. */
  event(name: string, ...args: unknown[]): void {
    this.port?.postMessage({ t: "event", name, args });
  }

  /** Stop the extension: its frame goes, and everything it was doing with it. */
  stop(): void {
    this.frame?.remove();
    this.frame = this.port = null;
    for (const p of this.pending.values()) p.reject(new Error(`${this.extension.name} stopped`));
    this.pending.clear();
  }
}

/** The app's look, for a webview's page: its colours and fonts, so an extension's view fits in. */
function theme(): string {
  const style = getComputedStyle(document.documentElement);
  const vars = ["--bg", "--ink", "--muted", "--line", "--accent", "--accent-soft", "--selection", "--prose", "--mono"]
    .map((v) => `${v}: ${style.getPropertyValue(v).trim()};`)
    .join(" ");
  return `<style>:root { ${vars} color-scheme: light dark; } body { margin: 0; padding: 0.5rem; background: transparent; color: var(--ink); font: 0.875rem/1.5 var(--prose); }</style>`;
}

/** What a webview's page has done, as far as test levers can tell (docs/TESTING.md): loaded, and first drawn on a canvas. */
export interface WebviewStatus {
  loaded: boolean;
  /** Draw calls on its canvases by the time it first drew, by kind; zero until it draws. */
  drawn: { webgl: number; "2d": number };
}

/** What a webview's page shows now, asked of it with test levers on: its canvases, sampled. */
export interface WebviewProbe {
  frames: number;
  drawn: { webgl: number; "2d": number };
  canvases: Array<{ kind: string; width: number; height: number; filled: number; colors: number }>;
}

/** Each webview on the page, by its frame, for test levers to report on. */
export const webviews = new WeakMap<HTMLIFrameElement, Webview>();

/** A visible sandboxed frame an extension draws into, with its own port. */
export class Webview {
  readonly frame = document.createElement("iframe");
  readonly status: WebviewStatus = { loaded: false, drawn: { webgl: 0, "2d": 0 } };
  private port: Promise<MessagePort>;
  private probes = new Map<number, (answer: unknown) => void>();

  constructor(
    container: HTMLElement,
    readonly id: string,
    title: string,
    onMessage: (message: unknown) => void,
    /** Its page's height, as it changes, for a frame that sizes to its content. */
    onHeight?: (height: number) => void,
    /** Its page has loaded, scripts and all. */
    onLoaded?: () => void,
    /** Its page has first painted something: show the frame now. */
    onPainted?: () => void,
  ) {
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.className = "webview";
    this.frame.title = title;
    // With test levers, the shell counts what its page draws and answers probes.
    this.frame.src = leversPage() ? "/sandbox/webview?probe" : "/sandbox/webview";
    webviews.set(this.frame, this);
    this.port = connect(this.frame).then((port) => {
      let alive = 0;
      // Writing its HTML loads the frame again, and so does navigating it away, which the app's
      // frame-src blocks, leaving an error page. The shell answers a ping only in the first case.
      this.frame.addEventListener("load", () => {
        const asked = ++alive;
        port.postMessage({ type: "ping", id: asked });
        setTimeout(() => {
          if (alive !== asked + 0.5) {
            const note = document.createElement("p");
            note.className = "message";
            note.textContent = `${title} tried to navigate away from its sandbox, so it was stopped.`;
            this.frame.replaceWith(note);
          }
        }, 1000);
      });
      port.onmessage = (e) => {
        const m = e.data as { type: string; data?: unknown; id?: number; height?: number; drawn?: WebviewStatus["drawn"] };
        // A webview's page is the extension's too: what it sends its extension is held to the size of a call.
        if (m.type === "message" && (measure(m.data, MAX_CALL) ?? Infinity) <= MAX_CALL) onMessage(m.data);
        if (m.type === "height" && typeof m.height === "number") onHeight?.(m.height);
        if (m.type === "loaded") {
          this.status.loaded = true;
          onLoaded?.();
        }
        if (m.type === "drawn" && m.drawn) this.status.drawn = m.drawn;
        if (m.type === "painted") onPainted?.();
        if (m.type === "probe" && typeof m.id === "number") this.probes.get(m.id)?.(m);
        if (m.type === "pong" && m.id === alive) alive += 0.5;
      };
      return port;
    });
    container.append(this.frame);
  }

  /** Show this HTML, in the app's colours and fonts, in standards mode (so its page is as tall as what's on it). */
  async setHtml(html: string): Promise<void> {
    (await this.port).postMessage({ type: "html", html: `<!doctype html>${theme()}${html.replace(/^\s*<!doctype[^>]*>/i, "")}` });
  }

  async post(message: unknown): Promise<void> {
    (await this.port).postMessage({ type: "message", data: message });
  }

  /** Ask the page what it shows now (test levers only: without them, its shell doesn't answer). */
  async probe(): Promise<WebviewProbe> {
    const id = this.probes.size + Math.random();
    const answer = new Promise<WebviewProbe>((resolve, reject) => {
      this.probes.set(id, (a) => {
        const { frames, drawn, canvases } = a as WebviewProbe;
        resolve({ frames, drawn, canvases });
      });
      setTimeout(() => reject(new Error("The webview didn't answer")), 3000);
    }).finally(() => this.probes.delete(id));
    (await this.port).postMessage({ type: "probe", id });
    return answer;
  }
}
