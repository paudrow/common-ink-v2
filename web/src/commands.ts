// Everything the app can do, by id. Keybindings, the command bar and Vim's ex commands all run
// commands from here, so each action has one name and one implementation.
import { matchKeys, type KeyLike } from "./keys.ts";

export interface Command {
  id: string;
  title: string;
  run(): unknown;
}

export interface Keybinding {
  key: string;
  command: string;
}

export class Commands {
  private byId = new Map<string, Command>();

  register(...commands: Command[]): void {
    for (const c of commands) this.byId.set(c.id, c);
  }

  all(): Command[] {
    return [...this.byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Run a command by id. False if there's no such command. */
  run(id: string): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    void command.run();
    return true;
  }
}

/** The command a key press is bound to, if any. A later binding for the same key wins. */
export function commandForKey(e: KeyLike, bindings: readonly Keybinding[], mac?: boolean): string | null {
  for (let i = bindings.length - 1; i >= 0; i--) if (matchKeys(e, bindings[i].key, mac)) return bindings[i].command;
  return null;
}

/** The first key bound to a command, for showing next to it. */
export function keyFor(command: string, bindings: readonly Keybinding[]): string | undefined {
  return bindings.find((b) => b.command === command)?.key;
}
