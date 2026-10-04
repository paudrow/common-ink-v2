// A window's tab bar, kept in step with the layout by updating its tab nodes in place. Nodes are only
// added, removed or moved when the tabs themselves change, never for a save status or focus change, so
// a press on a tab always meets the same node on release. A tab is selected on press, as in VSCode.

export interface TabModel {
  /** Stable for as long as the tab shows the same thing (openableKey). */
  key: string;
  label: string;
  title: string;
  selected: boolean;
  preview: boolean;
  /** A save status other than saved, shown as a dot. */
  status?: string;
}

export interface TabActions {
  select(key: string): void;
  close(key: string): void;
  keep(key: string): void;
  menu(key: string, x: number, y: number): void;
  dragStart(key: string, e: DragEvent): void;
  dragEnd(): void;
}

const nodes = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

/** Make `bar` show `tabs`, reusing the node each tab already has. */
export function syncTabs(bar: HTMLElement, tabs: TabModel[], actions: TabActions): void {
  let byKey = nodes.get(bar);
  if (!byKey) nodes.set(bar, (byKey = new Map()));
  const wanted = new Set(tabs.map((t) => t.key));
  for (const [key, el] of byKey) {
    if (!wanted.has(key)) {
      el.remove();
      byKey.delete(key);
    }
  }
  tabs.forEach((t, i) => {
    let el = byKey!.get(t.key);
    if (!el) byKey!.set(t.key, (el = makeTab(t.key, actions)));
    update(el, t);
    // Only move a node that's out of place.
    if (bar.children[i] !== el) bar.insertBefore(el, bar.children[i] ?? null);
  });
}

function makeTab(key: string, actions: TabActions): HTMLElement {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.setAttribute("role", "tab");
  tab.draggable = true;
  const name = document.createElement("button");
  name.className = "name";
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  tab.append(name, close);
  // Select on press with the main button, as VSCode does; the close button and dragging still work.
  name.addEventListener("pointerdown", (e) => {
    if (e.button === 0) actions.select(key);
  });
  // Enter or Space on the focused tab (a click with no pointer press before it).
  name.addEventListener("click", () => actions.select(key));
  name.addEventListener("auxclick", (e) => e.button === 1 && actions.close(key));
  close.addEventListener("click", () => actions.close(key));
  tab.addEventListener("dblclick", (e) => {
    if (e.target !== close) actions.keep(key);
  });
  tab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // From the keyboard's menu key there's no pointer: the menu goes under the tab.
    const box = tab.getBoundingClientRect();
    actions.menu(key, e.clientX || box.left, e.clientY || box.bottom);
  });
  tab.addEventListener("dragstart", (e) => actions.dragStart(key, e));
  tab.addEventListener("dragend", () => actions.dragEnd());
  return tab;
}

function update(tab: HTMLElement, t: TabModel) {
  const name = tab.firstElementChild as HTMLElement;
  const close = tab.lastElementChild as HTMLElement;
  if (name.textContent !== t.label) name.textContent = t.label;
  if (tab.title !== t.title) tab.title = t.title;
  tab.setAttribute("aria-selected", String(t.selected));
  tab.classList.toggle("preview", t.preview);
  if (t.status) name.dataset.status = t.status;
  else delete name.dataset.status;
  close.setAttribute("aria-label", `Close ${t.label}`);
}
