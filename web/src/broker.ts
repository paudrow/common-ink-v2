// The permission broker (ADR 0006): every sensitive thing an extension does goes through here. It
// checks the extension's manifest (an undeclared permission can never be granted), then your answers
// in settings, and asks you the first time, with the extension's reason and what you did that it's
// acting on. Prompts come one at a time; asks from the same extension while its prompt is up join
// that prompt. Everything decided is logged for the Extension activity view.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import { decide, type Answer, type Ask, type Grants } from "../../worker/src/permissions.ts";
import { changeIn, plain, refusedWords, scopeWords, type Refusal, type Trigger } from "./permission-words.ts";

/** What you chose in a prompt. "dismiss" is Escape: no, but only for now, so a stray key can't block an extension for good. */
export type Choice = "once" | "always" | "deny" | "dismiss";

/** Something an extension tried, refused, and why: its message says so in words, naming no internal path. */
export class PermissionDenied extends Error {
  constructor(
    readonly extension: ExtensionManifest,
    readonly ask: Ask,
    readonly refusal: Refusal,
  ) {
    const said = plain(refusedWords(extension.name, ask, refusal));
    super(refusal.reason === "undeclared" ? said : `${said} Change that in ${changeIn(extension.name)}.`);
  }
}

/** One thing in the activity log: what an extension did or tried, and how it went. */
export interface Activity {
  time: number;
  extension: string;
  ask: Ask;
  /** A network request's address. */
  url?: string;
  outcome: "allowed" | "denied" | "failed" | "in flight";
}

/** How long after you do something an extension's asks are still taken to be about it. */
const CAUSE_MS = 10_000;

export interface BrokerOptions {
  grants(): Grants;
  isBuiltIn(id: string): boolean;
  /** Keep an answer in settings. */
  save(extension: string, key: string, answer: Answer): Promise<void>;
  /**
   * Show a prompt for these asks, and resolve with what you chose. More asks from the same extension
   * may join while it's up: `joined` is called with each, for the prompt to show it too.
   */
  prompt(extension: ExtensionManifest, asks: Array<{ ask: Ask; key: string }>, joined: (fn: (ask: { ask: Ask; key: string }) => void) => void, trigger: Trigger | null): Promise<Choice>;
  /** An extension tried something its manifest doesn't ask for: once per extension and kind, for you to hear of it. */
  undeclared(denied: PermissionDenied): void;
  changed(): void;
}

interface Prompting {
  extension: ExtensionManifest;
  trigger: Trigger | null;
  asks: Array<{ ask: Ask; key: string }>;
  answer: Promise<Choice>;
  resolve(choice: Choice): void;
  /** Told of asks that join once the prompt is showing. */
  onJoin?: (ask: { ask: Ask; key: string }) => void;
}

export class PermissionBroker {
  /** "Allow once" answers, this session only. */
  private once = new Set<string>();
  /** "Don't allow" without keeping it (Escape), this session only. */
  private deniedForNow = new Set<string>();
  /**
   * Answers chosen but not yet in settings: keeping one takes a moment (a write, then settings read
   * again), and an ask in that moment (the extension trying again, or hearing its own settings save)
   * must get the answer you just gave, not another prompt.
   */
  private keeping = new Map<string, Answer>();
  private queue: Prompting[] = [];
  private showing: Prompting | null = null;
  readonly log: Activity[] = [];
  private inFlight = new Map<string, number>();
  /** What you did last that each extension is acting on, and when. */
  private causes = new Map<string, { trigger: Trigger; at: number }>();
  /** Extensions and kinds you've heard tried something undeclared, this session. */
  private told = new Set<string>();

  constructor(private o: BrokerOptions) {}

  /**
   * You did something an extension acts on: its asks in the next few seconds say so. A view drawing is
   * a weaker reason than what led to it (the command that showed it), so it doesn't replace a recent one.
   */
  cause(extension: string, trigger: Trigger): void {
    if (trigger.kind === "view" && this.causeOf(extension)) return;
    this.causes.set(extension, { trigger, at: Date.now() });
  }

  /** What you did that an extension's ask now is about, if it was just now. */
  private causeOf(extension: string): Trigger | null {
    const c = this.causes.get(extension);
    return c && Date.now() - c.at < CAUSE_MS ? c.trigger : null;
  }

  /** Allow `ask` for `extension`, asking you if need be. Throws PermissionDenied otherwise. */
  async check(extension: ExtensionManifest, ask: Ask): Promise<void> {
    const decision = decide(extension, ask, this.o.grants(), { builtIn: this.o.isBuiltIn(extension.id), once: this.once });
    const record = (outcome: Activity["outcome"]) => this.record(extension.id, ask, outcome);
    if (decision.outcome === "undeclared") {
      record("denied");
      const declared = extension.permissions[ask.kind];
      const scopes = declared ? (declared.hosts ?? declared.paths ?? declared.keys ?? []) : [];
      const denied = new PermissionDenied(extension, ask, { reason: "undeclared", scopes });
      const told = `${extension.id} ${ask.kind}`;
      if (!this.told.has(told)) {
        this.told.add(told);
        this.o.undeclared(denied);
      }
      throw denied;
    }
    const key = `${extension.id} ${decision.key}`;
    let outcome = decision.outcome;
    if (outcome === "ask" && this.keeping.has(key)) outcome = this.keeping.get(key)!;
    let forNow = outcome === "ask" && this.deniedForNow.has(key);
    if (forNow) outcome = "deny";
    if (outcome === "ask") {
      const choice = await this.ask(extension, ask, decision.key);
      if (choice === "once") this.once.add(key);
      if (choice === "dismiss") this.deniedForNow.add(key);
      if (choice === "always" || choice === "deny") await this.keep(extension.id, decision.key, choice === "always" ? "allow" : "deny");
      outcome = choice === "deny" || choice === "dismiss" ? "deny" : "allow";
      forNow = choice === "dismiss";
    }
    if (outcome === "deny") {
      record("denied");
      const scope = decision.key.slice(ask.kind.length + 1) || undefined;
      throw new PermissionDenied(extension, ask, forNow ? { reason: "now" } : { reason: "answer", scope: scopeWords(ask.kind, scope) });
    }
    record("allowed");
  }

  /** Keep an answer in settings, once, however many asks it answered. */
  private async keep(extension: string, key: string, answer: Answer): Promise<void> {
    const k = `${extension} ${key}`;
    if (this.keeping.has(k)) return;
    this.keeping.set(k, answer);
    try {
      await this.o.save(extension, key, answer);
    } finally {
      this.keeping.delete(k);
    }
  }

  /**
   * Whether `ask` is allowed now, without asking or waiting: declared, and allowed by your answer, for
   * this session, or as a built-in's. For what a browser allows only while it handles a click (the
   * clipboard), which can't wait for a check.
   */
  granted(extension: ExtensionManifest, ask: Ask): boolean {
    const d = decide(extension, ask, this.o.grants(), { builtIn: this.o.isBuiltIn(extension.id), once: this.once });
    if (d.outcome !== "allow") return false;
    this.record(extension.id, ask, "allowed");
    return true;
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
    this.queue.push({ extension, trigger: this.causeOf(extension.id), asks: [{ ask, key }], answer, resolve });
    void this.pump();
    return answer;
  }

  private async pump() {
    if (this.showing) return;
    const next = this.queue.shift();
    if (!next) return;
    this.showing = next;
    next.resolve(await this.o.prompt(next.extension, [...next.asks], (fn) => (next.onJoin = fn), next.trigger));
    this.showing = null;
    void this.pump();
  }

  /** Note something an extension did, for the activity log. */
  record(extension: string, ask: Ask, outcome: Activity["outcome"], url?: string): Activity {
    const entry: Activity = { time: Date.now(), extension, ask, outcome, ...(url ? { url } : {}) };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, 500);
    this.o.changed();
    return entry;
  }

  /** Run a network request for an extension, counted as in flight while it runs. */
  async inFlightWhile<T>(extension: string, url: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.set(extension, (this.inFlight.get(extension) ?? 0) + 1);
    const entry = this.record(extension, { kind: "network", target: hostOf(url) }, "in flight", url);
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

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
