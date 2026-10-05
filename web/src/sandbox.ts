// The app's side of sandboxed extensions (ADR 0006): an extension host for each sandboxed extension,
// a hidden iframe with sandbox="allow-scripts" that lives as long as the page, so a timer keeps going
// when its note closes; and webviews, visible sandboxed iframes an extension draws into. Each talks to
// the app over its own MessagePort, never by window messages anyone could send.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";

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
          if (m.t === "result") p?.resolve(m.value);
          else p?.reject(new Error(m.message));
        }
      };
    });
    port.postMessage({ t: "start", extension: this.extension, code, settings, me });
    await started;
  }

  private async answer(id: string, method: string, args: unknown[]) {
    try {
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

/** A visible sandboxed frame an extension draws into, with its own port. */
export class Webview {
  readonly frame = document.createElement("iframe");
  private port: Promise<MessagePort>;

  constructor(
    container: HTMLElement,
    readonly id: string,
    title: string,
    onMessage: (message: unknown) => void,
    /** Its page's height, as it changes, for a frame that sizes to its content. */
    onHeight?: (height: number) => void,
    /** Its page has loaded, scripts and all. */
    onLoaded?: () => void,
  ) {
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.className = "webview";
    this.frame.title = title;
    this.frame.src = "/sandbox/webview";
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
        const m = e.data as { type: string; data?: unknown; id?: number; height?: number };
        if (m.type === "message") onMessage(m.data);
        if (m.type === "height" && typeof m.height === "number") onHeight?.(m.height);
        if (m.type === "loaded") onLoaded?.();
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
}
