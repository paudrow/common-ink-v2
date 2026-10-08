// Everything the app can do, by id. Keybindings, the command bar and Vim's ex commands all run
// commands from here, so each action has one name and one implementation.
import { matchKeys, type KeyLike } from "./keys.ts";

export interface Command {
  id: string;
  title: string;
  run(): unknown;
  /** Why it's off on this device, if it is ("Off on this device · needs a screen 840px wide"): listed greyed, and running it says so instead. */
  off?(): string | null;
  /** Only the app runs it, from a key, a menu or the command bar: a sandboxed extension's commands.run is refused. */
  appOnly?: boolean;
}

export type { Keybinding } from "../../worker/src/settings.ts";
import type { Keybinding, Sandboxed } from "../../worker/src/settings.ts";

/** Who a command runs for: the app (you, through a key, a menu or the command bar), or a sandboxed extension, by its code or what its manifest contributes. */
export type RunBy = "app" | Sandboxed;

/** Why an app-only command a sandboxed extension asked for didn't run. */
export const APP_ONLY = "An extension asked to run it, and only you can";

export class Commands {
  private byId = new Map<string, Command>();

  /** @param refused says why a command didn't run, and who asked: it's off on this device, or it's app-only and an extension asked. */
  constructor(private refused: (title: string, why: string, by: RunBy) => void = () => {}) {}

  register(...commands: Command[]): void {
    for (const c of commands) this.byId.set(c.id, c);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The command registered under an id now: a later registration replaces it. */
  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  all(): Command[] {
    return [...this.byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Run a command by id. False if there's no such command. An app-only one a sandboxed extension asks for is refused, and said so. */
  run(id: string, by: RunBy = "app"): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    const off = this.refusal(command, by);
    if (off) this.refused(command.title, off, by);
    else void command.run();
    return true;
  }

  /** Why a command won't run for whoever asked: an app-only one a sandboxed extension asked for, or one off on this device. */
  private refusal(command: Command, by: RunBy): string | null | undefined {
    return command.appOnly && by !== "app" ? APP_ONLY : command.off?.();
  }

  /**
   * Run a command for a key press. A command can decline the key by returning false at once (a list
   * command off a list): then the key should do what it would have done. True if it took the key. A
   * sandboxed extension's key for an app-only command is refused, as one that's off is.
   */
  runForKey(id: string, by: RunBy = "app"): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    const off = this.refusal(command, by);
    if (off) return (this.refused(command.title, off, by), true);
    return command.run() !== false;
  }
}

/** Refusals in a row for one sandboxed extension, in one notice: what it asked for, by why each was refused. */
export function refusalSummary(extension: string, refused: ReadonlyArray<{ title: string; why: string }>): string {
  const byWhy = new Map<string, Set<string>>();
  for (const { title, why } of refused) byWhy.set(why, (byWhy.get(why) ?? new Set()).add(title));
  const parts = [...byWhy].map(([why, titles]) => `${and([...titles])} (${why === APP_ONLY ? "only you can" : why.charAt(0).toLowerCase() + why.slice(1)})`);
  return `${refused.length} requests from ${extension} refused: ${parts.join("; ")}`;
}

const and = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]);

/**
 * The command a key press is bound to, if any. A later binding for the same key wins, and a null command
 * unbinds it. A binding the character typed matches comes before one matched by where the key sits, so
 * ⌘⇧E isn't taken for ⌘⇧. when the layout map says that key types a dot.
 */
export function commandForKey(e: KeyLike, bindings: readonly Keybinding[], mac?: boolean): string | null {
  return bindingForKey(e, bindings, mac)?.command ?? null;
}

/** The binding a key press matches, as commandForKey finds it, with who declared it. */
export function bindingForKey(e: KeyLike, bindings: readonly Keybinding[], mac?: boolean): Keybinding | null {
  for (const byPlace of [false, true]) for (let i = bindings.length - 1; i >= 0; i--) if (matchKeys(e, bindings[i].key, mac, byPlace)) return bindings[i];
  return null;
}

/** A key bound to a command and not rebound later, for showing next to it. */
export function keyFor(command: string, bindings: readonly Keybinding[]): string | undefined {
  return bindings.find((b, i) => b.command === command && !bindings.slice(i + 1).some((later) => later.key === b.key))?.key;
}
