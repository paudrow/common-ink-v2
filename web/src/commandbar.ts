// The command bar: one input over the editor. What's typed picks a provider by its prefix (">" for
// commands, nothing for search), and the provider lists what matches, in sections. A provider that takes
// the query language (search) gets chips that write filters into the query, and Tab to complete them.
// On a phone it fills the screen, and stays open until Cancel; on wider screens it's a dialog.
import { matchKeys } from "./keys.ts";
import { CHIPS, complete, hasFilter, toggleFilter, type FilterInfo } from "./search.ts";

export interface Item {
  label: string;
  detail?: string;
  /** A few words at the row's end: when, or where. */
  aside?: string;
  /** The heading of the section the item is in; items of a section come together. */
  section?: string;
  /** Shown quieter: archived. */
  dim?: boolean;
  run(): unknown;
}

export interface Provider {
  /** What the query starts with to use this provider. The longest matching prefix wins. */
  prefix: string;
  placeholder: string;
  /** What matches, now or once it's known: a sandboxed extension answers over a message. */
  items(query: string): Item[] | Promise<Item[]>;
  /** The query is in the query language (docs/queries.md): show chips, and complete filters with Tab. */
  query?: boolean;
}

/** The provider for a query, and the query without its prefix. Null if no provider takes it. */
export function providerFor(text: string, providers: readonly Provider[]): { provider: Provider; query: string } | null {
  const provider = [...providers].sort((a, b) => b.prefix.length - a.prefix.length).find((p) => text.startsWith(p.prefix));
  return provider ? { provider, query: text.slice(provider.prefix.length).trim() } : null;
}

const MAX_ITEMS = 50;

/** Under this width the bar fills the screen (the compact width class). */
const FULL_SCREEN = "(max-width: 599.98px)";

export class CommandBar {
  private root = document.createElement("div");
  private input = document.createElement("input");
  private cancel = document.createElement("button");
  private chips = document.createElement("div");
  private list = document.createElement("ul");
  private items: Item[] = [];
  private selected = 0;
  private returnFocus: HTMLElement | null = null;

  private providers: Provider[] = [];
  /** A one-off list to pick from (pick), in place of the providers until the bar closes. */
  private choices: Provider | null = null;

  constructor(
    /** The filters search knows, for completion, and the keys extensions add, for reading a query. */
    private filters: { all(): FilterInfo[]; extraKeys(): string[] } = { all: () => [], extraKeys: () => [] },
  ) {
    this.root.id = "command-bar";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Search and commands");
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.setAttribute("autocapitalize", "off");
    this.input.enterKeyHint = "go";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-controls", "command-bar-items");
    this.input.setAttribute("aria-expanded", "true");
    this.cancel.type = "button";
    this.cancel.className = "cancel";
    this.cancel.textContent = "Cancel";
    this.cancel.addEventListener("click", () => this.close());
    const field = document.createElement("div");
    field.className = "field";
    field.append(this.input, this.cancel);
    this.chips.className = "chips";
    this.chips.setAttribute("role", "toolbar");
    this.chips.setAttribute("aria-label", "Filters");
    this.list.id = "command-bar-items";
    this.list.setAttribute("role", "listbox");
    this.root.append(field, this.chips, this.list);
    document.body.append(this.root);
    // A tap on a chip or a row mustn't take focus from the field, which would close the bar or hide the keyboard.
    for (const el of [this.chips, this.list]) el.addEventListener("mousedown", (e) => e.preventDefault());
    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("blur", () => {
      if (!matchMedia(FULL_SCREEN).matches) this.close(false);
    });
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

  private found() {
    return this.choices ? { provider: this.choices, query: this.input.value.trim() } : providerFor(this.input.value, this.providers);
  }

  private render() {
    const found = this.found();
    this.input.placeholder = found?.provider.placeholder ?? "Nothing here: the command bar's extensions are turned off";
    this.drawChips(found?.provider.query ? found : null);
    const turn = ++this.turn;
    const items = found ? found.provider.items(found.query) : [];
    if (items instanceof Promise) {
      this.list.setAttribute("aria-busy", "true");
      void items.then((later) => turn === this.turn && this.show(later), () => turn === this.turn && this.show([]));
      return;
    }
    this.show(items);
  }

  /** The chips for a query-language provider: each pressed while its filter is in the query. */
  private drawChips(found: { provider: Provider; query: string } | null) {
    this.chips.hidden = !found;
    if (!found) return this.chips.replaceChildren();
    const extra = this.filters.extraKeys();
    this.chips.replaceChildren(
      ...CHIPS.map(({ label, filter }) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = label;
        chip.dataset.filter = filter;
        chip.setAttribute("aria-pressed", String(hasFilter(found.query, filter, extra)));
        chip.addEventListener("click", () => {
          this.input.value = found.provider.prefix + toggleFilter(found.query, filter, extra);
          this.input.setSelectionRange(this.input.value.length, this.input.value.length);
          this.render();
        });
        return chip;
      }),
    );
  }

  private show(items: Item[]) {
    this.list.removeAttribute("aria-busy");
    this.items = items.slice(0, MAX_ITEMS);
    this.selected = 0;
    const rows: HTMLElement[] = [];
    this.items.forEach((item, i) => {
      if (item.section && item.section !== this.items[i - 1]?.section) {
        const heading = document.createElement("li");
        heading.className = "section";
        heading.setAttribute("role", "presentation");
        heading.textContent = item.section;
        rows.push(heading);
      }
      const li = document.createElement("li");
      li.id = `command-bar-item-${i}`;
      li.setAttribute("role", "option");
      if (item.dim) li.classList.add("dim");
      const text = document.createElement("span");
      text.className = "text";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      text.append(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = item.detail;
        text.append(detail);
      }
      li.append(text);
      if (item.aside) {
        const aside = document.createElement("span");
        aside.className = "aside";
        aside.textContent = item.aside;
        li.append(aside);
      }
      li.addEventListener("click", () => this.choose(i));
      rows.push(li);
    });
    this.list.replaceChildren(...rows);
    this.highlight();
  }

  private options() {
    return [...this.list.querySelectorAll<HTMLElement>("li[role=option]")];
  }

  private highlight() {
    const options = this.options();
    options.forEach((li, i) => li.setAttribute("aria-selected", String(i === this.selected)));
    options[this.selected]?.scrollIntoView({ block: "nearest" });
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

  /** Tab: complete the filter before the caret, for a query-language provider. */
  private completeFilter(): void {
    if (!this.found()?.provider.query) return;
    const done = complete(this.input.value, this.input.selectionStart ?? this.input.value.length, this.filters.all());
    if (!done) return;
    this.input.value = done.text;
    this.input.setSelectionRange(done.caret, done.caret);
    this.render();
  }

  private key(e: KeyboardEvent) {
    const handled = (() => {
      if (matchKeys(e, "ArrowDown") || matchKeys(e, "Ctrl-n") || matchKeys(e, "Ctrl-j")) this.move(1);
      else if (matchKeys(e, "ArrowUp") || matchKeys(e, "Ctrl-p") || matchKeys(e, "Ctrl-k")) this.move(-1);
      else if (matchKeys(e, "Enter")) this.choose(this.selected);
      else if (matchKeys(e, "Escape")) this.close();
      else if (matchKeys(e, "Tab")) this.completeFilter();
      else return false;
      return true;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
