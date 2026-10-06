// The command bar: one input over the editor. What's typed picks a provider by its prefix (">" for
// commands, nothing for notes), and the provider lists what matches.
import { matchKeys } from "./keys.ts";

export interface Item {
  label: string;
  detail?: string;
  /** Off on this device: listed greyed, its detail saying why. */
  off?: boolean;
  run(): unknown;
}

export interface Provider {
  /** What the query starts with to use this provider. The longest matching prefix wins. */
  prefix: string;
  placeholder: string;
  /** What matches, now or once it's known: a sandboxed extension answers over a message. */
  items(query: string): Item[] | Promise<Item[]>;
}

/** The provider for a query, and the query without its prefix. Null if no provider takes it. */
export function providerFor(text: string, providers: readonly Provider[]): { provider: Provider; query: string } | null {
  const provider = [...providers].sort((a, b) => b.prefix.length - a.prefix.length).find((p) => text.startsWith(p.prefix));
  return provider ? { provider, query: text.slice(provider.prefix.length).trim() } : null;
}

const MAX_ITEMS = 50;

export class CommandBar {
  private root = document.createElement("div");
  private input = document.createElement("input");
  private list = document.createElement("ul");
  private items: Item[] = [];
  private selected = 0;
  private returnFocus: HTMLElement | null = null;

  private providers: Provider[] = [];
  /** A one-off list to pick from (pick), in place of the providers until the bar closes. */
  private choices: Provider | null = null;

  constructor() {
    this.root.id = "command-bar";
    this.root.hidden = true;
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-controls", "command-bar-items");
    this.input.setAttribute("aria-expanded", "true");
    this.list.id = "command-bar-items";
    this.list.setAttribute("role", "listbox");
    this.root.append(this.input, this.list);
    document.body.append(this.root);
    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("blur", () => this.close(false));
  }

  provide(provider: Provider): void {
    this.providers.push(provider);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Pick one of `items`, filtered by what's typed, as the command bar does for notes. */
  pick(placeholder: string, items: Item[]): void {
    this.choices = { prefix: "", placeholder, items: (q) => items.filter((i) => `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(q.toLowerCase())) };
    this.open();
  }

  open(text = ""): void {
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    this.input.value = text;
    this.render();
    this.input.focus();
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.choices = null;
    if (restoreFocus) this.returnFocus?.focus();
  }

  /** Each render's turn, so a provider's late answer to an old query doesn't replace a newer one. */
  private turn = 0;

  private render() {
    const found = this.choices ? { provider: this.choices, query: this.input.value.trim() } : providerFor(this.input.value, this.providers);
    this.input.placeholder = found?.provider.placeholder ?? "Nothing here: the command bar's extensions are turned off";
    const turn = ++this.turn;
    const items = found ? found.provider.items(found.query) : [];
    if (items instanceof Promise) {
      void items.then((later) => turn === this.turn && this.show(later), () => turn === this.turn && this.show([]));
      return;
    }
    this.show(items);
  }

  private show(items: Item[]) {
    this.items = items.slice(0, MAX_ITEMS);
    this.selected = 0;
    this.list.replaceChildren(
      ...this.items.map((item, i) => {
        const li = document.createElement("li");
        li.id = `command-bar-item-${i}`;
        li.setAttribute("role", "option");
        if (item.off) li.classList.add("off");
        const label = document.createElement("span");
        label.textContent = item.label;
        li.append(label);
        if (item.detail) {
          const detail = document.createElement("span");
          detail.className = "detail";
          detail.textContent = item.detail;
          li.append(detail);
        }
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.choose(i);
        });
        return li;
      }),
    );
    this.highlight();
  }

  private highlight() {
    [...this.list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === this.selected)));
    this.list.children[this.selected]?.scrollIntoView({ block: "nearest" });
    this.input.setAttribute("aria-activedescendant", this.items.length ? `command-bar-item-${this.selected}` : "");
  }

  private move(by: number) {
    if (!this.items.length) return;
    this.selected = (this.selected + by + this.items.length) % this.items.length;
    this.highlight();
  }

  private choose(i: number) {
    const item = this.items[i];
    if (!item) return;
    this.close();
    void item.run();
  }

  private key(e: KeyboardEvent) {
    const handled = (() => {
      if (matchKeys(e, "ArrowDown") || matchKeys(e, "Ctrl-n") || matchKeys(e, "Ctrl-j")) this.move(1);
      else if (matchKeys(e, "ArrowUp") || matchKeys(e, "Ctrl-p") || matchKeys(e, "Ctrl-k")) this.move(-1);
      else if (matchKeys(e, "Enter")) this.choose(this.selected);
      else if (matchKeys(e, "Escape")) this.close();
      else return false;
      return true;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
