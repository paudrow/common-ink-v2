// Everything the app can do, by id. Keybindings, the command bar and Vim's ex commands all run
// commands from here, so each action has one name and one implementation.
import { matchKeys, type KeyLike } from "./keys.ts";

export interface Command {
  id: string;
  title: string;
  run(): unknown;
  /** Why it's off on this device, if it is ("Off on this device · needs a screen 840px wide"): listed greyed, and running it says so instead. */
  off?(): string | null;
}

export type { Keybinding } from "../../worker/src/settings.ts";
import type { Keybinding } from "../../worker/src/settings.ts";

export class Commands {
  private byId = new Map<string, Command>();

  /** @param refused says why a command that's off on this device didn't run. */
  constructor(private refused: (title: string, why: string) => void = () => {}) {}

  register(...commands: Command[]): void {
    for (const c of commands) this.byId.set(c.id, c);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  all(): Command[] {
    return [...this.byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Run a command by id. False if there's no such command. */
  run(id: string): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    const off = command.off?.();
    if (off) this.refused(command.title, off);
    else void command.run();
    return true;
  }

  /**
   * Run a command for a key press. A command can decline the key by returning false at once (a list
   * command off a list): then the key should do what it would have done. True if it took the key.
   */
  runForKey(id: string): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    const off = command.off?.();
    if (off) return (this.refused(command.title, off), true);
    return command.run() !== false;
  }
}

/**
 * The command a key press is bound to, if any. A later binding for the same key wins, and a null command
 * unbinds it. A binding the character typed matches comes before one matched by where the key sits, so
 * ⌘⇧E isn't taken for ⌘⇧. when the layout map says that key types a dot.
 */
export function commandForKey(e: KeyLike, bindings: readonly Keybinding[], mac?: boolean): string | null {
  for (const byPlace of [false, true]) for (let i = bindings.length - 1; i >= 0; i--) if (matchKeys(e, bindings[i].key, mac, byPlace)) return bindings[i].command;
  return null;
}

/** A key bound to a command and not rebound later, for showing next to it. */
export function keyFor(command: string, bindings: readonly Keybinding[]): string | undefined {
  return bindings.find((b, i) => b.command === command && !bindings.slice(i + 1).some((later) => later.key === b.key))?.key;
}
