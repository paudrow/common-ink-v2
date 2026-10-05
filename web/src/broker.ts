// The permission broker (ADR 0006): every sensitive thing an extension does goes through here. It
// checks the extension's manifest (an undeclared permission can never be granted), then your answers
// in settings, and asks you the first time, with the extension's reason. Prompts come one at a time;
// asks from the same extension while its prompt is up join that prompt. Everything decided is logged
// for the Extension activity view.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import { decide, type Answer, type Ask, type Grants } from "../../worker/src/permissions.ts";

/** What you chose in a prompt. "dismiss" is Escape: no, but only for now, so a stray key can't block an extension for good. */
export type Choice = "once" | "always" | "deny" | "dismiss";

export class PermissionDenied extends Error {}

/** One thing in the activity log. */
export interface Activity {
  time: number;
  extension: string;
  kind: string;
  detail: string;
  outcome: "allowed" | "denied" | "failed" | "in flight";
}

export interface BrokerOptions {
  grants(): Grants;
  isBuiltIn(id: string): boolean;
  /** Keep an answer in settings. */
  save(extension: string, key: string, answer: Answer): Promise<void>;
  /**
   * Show a prompt for these asks, and resolve with what you chose. More asks from the same extension
   * may join while it's up: `joined` is called with each, for the prompt to show it too.
   */
  prompt(extension: ExtensionManifest, asks: Array<{ ask: Ask; key: string }>, joined: (fn: (ask: { ask: Ask; key: string }) => void) => void): Promise<Choice>;
  changed(): void;
}

interface Prompting {
  extension: ExtensionManifest;
  asks: Array<{ ask: Ask; key: string }>;
  answer: Promise<Choice>;
  resolve(choice: Choice): void;
  /** Told of asks that join once the prompt is showing. */
  onJoin?: (ask: { ask: Ask; key: string }) => void;
}

/** How a kind of permission reads in a prompt: "connect to api.weather.gov". */
export function describeAsk(ask: Ask): string {
  const target = ask.target ?? ask.scope;
  switch (ask.kind) {
    case "network":
      return `connect to ${target}`;
    case "files:read":
      return `read ${target === "**" ? "your notes" : target}`;
    case "files:write":
      return `change ${target === "**" ? "your notes" : target}`;
    case "clipboard:read":
      return "read your clipboard";
    case "clipboard:write":
      return "copy to your clipboard";
    case "notifications":
      return "show notifications";
    case "media":
      return "play sound";
    case "history:read":
      return "read your history";
    case "calendar:read":
      return "read your calendar";
    case "contacts:read":
      return "read your contacts";
    case "settings:write":
      return `change the setting ${target}`;
    case "editor":
      return "change how notes are edited";
  }
}

export class PermissionBroker {
  /** "Allow once" answers, this session only. */
  private once = new Set<string>();
  /** "Don't allow" without keeping it (Escape), this session only. */
  private deniedForNow = new Set<string>();
  private queue: Prompting[] = [];
  private showing: Prompting | null = null;
  readonly log: Activity[] = [];
  private inFlight = new Map<string, number>();

  constructor(private o: BrokerOptions) {}

  /** Allow `ask` for `extension`, asking you if need be. Throws PermissionDenied otherwise. */
  async check(extension: ExtensionManifest, ask: Ask): Promise<void> {
    const decision = decide(extension, ask, this.o.grants(), { builtIn: this.o.isBuiltIn(extension.id), once: this.once });
    const record = (outcome: Activity["outcome"]) => this.record(extension.id, ask.kind, ask.target ?? ask.scope ?? "", outcome);
    if (decision.outcome === "undeclared") {
      record("denied");
      throw new PermissionDenied(`${extension.name} didn't declare that it may ${describeAsk(ask)}, so it can't`);
    }
    const key = `${extension.id} ${decision.key}`;
    let outcome = decision.outcome;
    if (outcome === "ask" && this.deniedForNow.has(key)) outcome = "deny";
    if (outcome === "ask") {
      const choice = await this.ask(extension, ask, decision.key);
      if (choice === "always") await this.o.save(extension.id, decision.key, "allow");
      if (choice === "once") this.once.add(key);
      if (choice === "deny") await this.o.save(extension.id, decision.key, "deny");
      if (choice === "dismiss") this.deniedForNow.add(key);
      outcome = choice === "deny" || choice === "dismiss" ? "deny" : "allow";
    }
    if (outcome === "deny") {
      record("denied");
      throw new PermissionDenied(`You didn't allow ${extension.name} to ${describeAsk(ask)}. Change that in the Extensions view.`);
    }
    record("allowed");
  }

  /** Whether `ask` was allowed only for this session, for telling the Worker so. */
  allowedOnce(extension: ExtensionManifest, ask: Ask): boolean {
    const d = decide(extension, ask, this.o.grants(), { builtIn: this.o.isBuiltIn(extension.id) });
    return d.outcome !== "undeclared" && this.once.has(`${extension.id} ${d.key}`);
  }

  private ask(extension: ExtensionManifest, ask: Ask, key: string): Promise<Choice> {
    // The same extension asking again while its prompt is up joins that prompt.
    const joining = [this.showing, ...this.queue].find((p) => p?.extension.id === extension.id);
    if (joining) {
      if (!joining.asks.some((a) => a.key === key)) {
        joining.asks.push({ ask, key });
        joining.onJoin?.({ ask, key });
      }
      return joining.answer;
    }
    let resolve!: (c: Choice) => void;
    const answer = new Promise<Choice>((r) => (resolve = r));
    this.queue.push({ extension, asks: [{ ask, key }], answer, resolve });
    void this.pump();
    return answer;
  }

  private async pump() {
    if (this.showing) return;
    const next = this.queue.shift();
    if (!next) return;
    this.showing = next;
    next.resolve(await this.o.prompt(next.extension, [...next.asks], (fn) => (next.onJoin = fn)));
    this.showing = null;
    void this.pump();
  }

  /** Note something an extension did, for the activity log. */
  record(extension: string, kind: string, detail: string, outcome: Activity["outcome"]): Activity {
    const entry = { time: Date.now(), extension, kind, detail, outcome };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, 500);
    this.o.changed();
    return entry;
  }

  /** Run a network request for an extension, counted as in flight while it runs. */
  async inFlightWhile<T>(extension: string, detail: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.set(extension, (this.inFlight.get(extension) ?? 0) + 1);
    const entry = this.record(extension, "network", detail, "in flight");
    try {
      const out = await run();
      entry.outcome = "allowed";
      return out;
    } catch (err) {
      entry.outcome = "failed";
      throw err;
    } finally {
      const left = (this.inFlight.get(extension) ?? 1) - 1;
      if (left) this.inFlight.set(extension, left);
      else this.inFlight.delete(extension);
      this.o.changed();
    }
  }

  /** The extensions with a network request in flight now. */
  busy(): string[] {
    return [...this.inFlight.keys()];
  }
}
