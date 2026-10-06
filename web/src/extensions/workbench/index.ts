// Workbench, a built-in extension: the windows' chrome, drawn around the core's layout model (ADR 0006).
// Tab bars with preview tabs (tabbar.ts), each tab's menu (menu.ts), dragging tabs, notes and panels
// into windows (dnd.ts), the borders that resize windows, and what an empty window says; and the
// commands that split, focus, resize and close windows and move and close tabs. Vim's Ctrl-W keys
// are the Vim extension's, bound to these commands.
import { EditorView } from "@codemirror/view";
import * as L from "common-ink/layout";
import type { ExtensionContext } from "../../extension-api.ts";
import { dragged, droppable, dropZone, endDrag, startDrag, tabIndexAt, type Dragged, type Zone } from "./dnd.ts";
import { SEPARATOR, showMenu, type MenuItem } from "./menu.ts";
import { syncTabs, type TabActions } from "./tabbar.ts";

export default {
  activate(ctx: ExtensionContext) {
    const layout = ctx.layout;
    // A tab or a note dropped on an editor opens in its window (below): the editor doesn't also type
    // the name it carries for other apps into the note.
    ctx.editor.extend(EditorView.domEventHandlers({ drop: (e) => droppable(e) }));
    const focused = () => L.focused(layout.get());

    const commands: Record<string, () => unknown> = {
      "tab.closeOthers": () => layout.closeTabs((_, i) => i !== focused().active),
      "tab.closeRight": () => layout.closeTabs((_, i) => i > focused().active),
      "tab.closeLeft": () => layout.closeTabs((_, i) => i < focused().active),
      "tab.closeSaved": () => layout.closeTabs((_, __, saved) => saved),
      "tab.closeAll": () => layout.closeTabs(() => true),
      "tab.keepOpen": () => layout.change((l) => L.keepTab(l, l.focus, L.focused(l).active)),
      "tab.copyPath": () => {
        const tab = L.activeTab(focused());
        if (tab && "file" in tab) void ctx.clipboard.write(tab.file);
      },
      "tab.next": () => layout.change((l) => L.cycleTab(l, 1)),
      "tab.previous": () => layout.change((l) => L.cycleTab(l, -1)),
      "window.splitRight": () => ctx.workbench.split("right"),
      "window.splitDown": () => ctx.workbench.split("down"),
      "window.splitLeft": () => ctx.workbench.split("left"),
      "window.splitUp": () => ctx.workbench.split("up"),
      "window.only": () => layout.change(L.only),
      "window.next": () => layout.change((l) => L.cycleGroup(l, 1)),
      "window.left": () => layout.change((l) => L.focusDirection(l, "left")),
      "window.right": () => layout.change((l) => L.focusDirection(l, "right")),
      "window.up": () => layout.change((l) => L.focusDirection(l, "up")),
      "window.down": () => layout.change((l) => L.focusDirection(l, "down")),
      "tab.moveLeft": () => layout.change((l) => L.moveTabDirection(l, "left")),
      "tab.moveRight": () => layout.change((l) => L.moveTabDirection(l, "right")),
      "tab.moveUp": () => layout.change((l) => L.moveTabDirection(l, "up")),
      "tab.moveDown": () => layout.change((l) => L.moveTabDirection(l, "down")),
      "tab.moveEarlier": () => layout.change((l) => L.shiftTab(l, -1)),
      "tab.moveLater": () => layout.change((l) => L.shiftTab(l, 1)),
      "window.wider": () => layout.change((l) => L.resizeFocused(l, "row", 0.05)),
      "window.narrower": () => layout.change((l) => L.resizeFocused(l, "row", -0.05)),
      "window.taller": () => layout.change((l) => L.resizeFocused(l, "column", 0.05)),
      "window.shorter": () => layout.change((l) => L.resizeFocused(l, "column", -0.05)),
      "window.equalize": () => layout.change(L.equalize),
    };
    for (const [id, run] of Object.entries(commands)) ctx.commands.register(id, run);

    /** The tab menu, for the focused window's tab on show: VSCode's items, each also a command. */
    const tabMenu = (): Array<MenuItem | null> => {
      const g = focused();
      const tab = g.tabs[g.active];
      const item = (command: string, label: string, disabled = false, by?: "sandbox"): MenuItem => ({ label, detail: ctx.commands.shortcut(command), disabled, run: () => ctx.commands.run(command, by) });
      return [
        item("tab.close", "Close"),
        item("tab.closeOthers", "Close Others", g.tabs.length < 2),
        item("tab.closeRight", "Close to the Right", g.active >= g.tabs.length - 1),
        item("tab.closeLeft", "Close to the Left", g.active === 0),
        item("tab.closeSaved", "Close Saved", !g.tabs.some((t) => layout.isSaved(t))),
        item("tab.closeAll", "Close All"),
        SEPARATOR,
        item("tab.keepOpen", "Keep Open", !tab?.preview),
        item("tab.copyPath", "Copy Path", !tab || !("file" in tab)),
        // Other extensions' items, for the file on show.
        ...ctx.commands.menu("tabMenu").map((i) => item(i.command, i.title, !tab || !("file" in tab), i.by)),
        SEPARATOR,
        item("window.splitRight", "Split Right"),
        item("window.splitDown", "Split Down"),
      ];
    };

    /** What a tab's clicks, drags and menu do. Tabs are found by key when the event happens, so a tab that moved still acts on itself. */
    const tabActions = (group: L.GroupId): TabActions => {
      const tabsOf = () => L.groups(layout.get()).find((g) => g.id === group)?.tabs ?? [];
      const withIndex = (fn: (i: number) => void) => (key: string) => {
        const i = tabsOf().findIndex((t) => L.openableKey(t) === key);
        if (i >= 0) fn(i);
      };
      return {
        select: withIndex((i) => layout.change((l) => L.selectTab(l, group, i))),
        close: withIndex((i) => void layout.close(group, i)),
        keep: withIndex((i) => layout.change((l) => L.keepTab(l, group, i))),
        menu: (key, x, y) =>
          withIndex((i) => {
            layout.change((l) => L.selectTab(l, group, i));
            showMenu(x, y, tabMenu());
          })(key),
        dragStart: (key, e) =>
          withIndex((i) => {
            const tab = tabsOf()[i];
            startDrag(e, { item: L.openableOf(tab), from: { group, index: i } }, layout.title(tab));
          })(key),
        dragEnd: endDrag,
      };
    };

    /** Something dropped on a window: a tab moves; anything else opens there. */
    const dropped = (what: Dragged, group: L.GroupId, zone: Zone | null, index: number) => {
      endDrag();
      if (what.from) {
        const to = zone === null ? { group, index } : zone === "center" ? { group } : { group, side: zone };
        layout.change((l) => L.moveTab(l, what.from!, to));
      } else if (zone === null) layout.change((l) => L.insertTab(l, what.item, group, index));
      else if (zone === "center") layout.change((l) => L.insertTab(l, what.item, group));
      else layout.change((l) => L.splitAt(l, group, zone, what.item));
    };

    // Anything the app marks as opening in a window (a note in the list, the side panel's title) drags into one.
    document.addEventListener("dragstart", (e) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>("[data-open]");
      if (el?.dataset.open) startDrag(e, { item: JSON.parse(el.dataset.open) as L.Openable }, el.textContent ?? "");
    });
    document.addEventListener("dragend", endDrag);

    /**
     * Back and forward (Go back, Go forward), at the start of the top left window's tab bar, when the
     * workbench.navigationArrows setting says: off by default, to keep the bar lean.
     */
    const arrows = (el: HTMLElement, bar: HTMLElement, id: L.GroupId) => {
      const on = ctx.settings.get<boolean>("workbench.navigationArrows") && L.groups(layout.get())[0]?.id === id;
      let nav = el.querySelector<HTMLElement>(":scope > .nav-arrows");
      bar.classList.toggle("with-nav", !!on);
      if (!on) return nav?.remove();
      if (!nav) {
        nav = document.createElement("div");
        nav.className = "nav-arrows chrome";
        for (const [text, by, command, title] of [
          ["←", -1, "go.back", "Go back"],
          ["→", 1, "go.forward", "Go forward"],
        ] as const) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = text;
          b.title = title;
          b.setAttribute("aria-label", title);
          b.dataset.by = String(by);
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => void ctx.commands.run(command));
          nav.append(b);
        }
        el.prepend(nav);
      }
      for (const b of nav.querySelectorAll<HTMLButtonElement>("button")) b.disabled = !ctx.workbench.canGo(Number(b.dataset.by) as -1 | 1);
    };

    layout.chrome({
      /** A window's tab bar, the marker where a dragged tab will go, and the overlay that shows where a drop will land. */
      window(el, id) {
        const tabs = document.createElement("div");
        tabs.className = "tabs";
        tabs.setAttribute("role", "tablist");
        const marker = document.createElement("div");
        marker.className = "insert";
        marker.hidden = true;
        const editors = el.querySelector<HTMLElement>(".editors")!;
        const drop = document.createElement("div");
        drop.className = "drop chrome";
        drop.hidden = true;
        editors.append(drop);
        el.prepend(tabs, marker);
        // Shift-Tab out of a note lands on its tab, not on the close button that comes last in the bar,
        // where Enter would close it. A press on the bar focuses what it pressed, as before.
        let pressing = false;
        tabs.addEventListener("pointerdown", () => {
          pressing = true;
          setTimeout(() => (pressing = false));
        });
        tabs.addEventListener("focusin", (e) => {
          if (pressing || !editors.contains(e.relatedTarget as Node)) return;
          tabs.querySelector<HTMLElement>('.tab[aria-selected="true"] .name')?.focus();
        });
        const hide = () => {
          drop.hidden = true;
          marker.hidden = true;
        };
        const target = (e: DragEvent): { zone: Zone | null; index: number } => {
          const tabEls = [...tabs.querySelectorAll<HTMLElement>(".tab")];
          if (tabs.contains(e.target as Node) || e.target === tabs) return { zone: null, index: tabIndexAt(tabEls.map((t) => t.getBoundingClientRect()), e.clientX) };
          return { zone: dropZone(editors.getBoundingClientRect(), e.clientX, e.clientY), index: -1 };
        };
        el.addEventListener("dragover", (e) => {
          if (!droppable(e)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = dragged(e)?.from ? "move" : "copy";
          const { zone, index } = target(e);
          if (zone) {
            drop.hidden = false;
            drop.dataset.zone = zone;
            marker.hidden = true;
          } else {
            drop.hidden = true;
            const tabEls = [...tabs.querySelectorAll<HTMLElement>(".tab")];
            const bar = tabs.getBoundingClientRect();
            const at = tabEls[index]?.getBoundingClientRect().left ?? tabEls.at(-1)?.getBoundingClientRect().right ?? bar.left;
            marker.hidden = false;
            marker.style.left = `${at - el.getBoundingClientRect().left - 1}px`;
          }
        });
        el.addEventListener("dragleave", (e) => {
          if (!el.contains(e.relatedTarget as Node)) hide();
        });
        el.addEventListener("drop", (e) => {
          if (!droppable(e)) return;
          // Ours, even if it isn't one to take: the browser doesn't drop it anywhere either.
          e.preventDefault();
          const what = dragged(e);
          hide();
          if (!what) return endDrag();
          const { zone, index } = target(e);
          dropped(what, id, zone, index);
        });
      },

      tabs(el, id, tabs) {
        const bar = el.querySelector<HTMLElement>(".tabs")!;
        syncTabs(bar, tabs, tabActions(id));
        arrows(el, bar, id);
      },

      /** The border between two windows: drag it to share their space differently. */
      divider(container, path, index) {
        const at = (): L.Split => path.reduce<L.Node>((n, i) => (n as L.Split).children[i], layout.get().root) as L.Split;
        const dir = at().dir;
        const el = document.createElement("div");
        el.className = `resizer ${dir}`;
        el.setAttribute("role", "separator");
        el.setAttribute("aria-orientation", dir === "row" ? "vertical" : "horizontal");
        el.addEventListener("pointerdown", (down) => {
          down.preventDefault();
          // The split as it is now: sizes may have changed since this border was drawn.
          const split = at();
          el.setPointerCapture(down.pointerId);
          const box = container.getBoundingClientRect();
          const total = split.dir === "row" ? box.width : box.height;
          const children = [...container.children].filter((c) => !c.classList.contains("resizer")) as HTMLElement[];
          const start = split.dir === "row" ? down.clientX : down.clientY;
          const pair = split.sizes[index - 1] + split.sizes[index];
          let sizes = split.sizes;
          const move = (e: PointerEvent) => {
            const moved = ((split.dir === "row" ? e.clientX : e.clientY) - start) / total;
            const before = Math.min(Math.max(0.1, split.sizes[index - 1] + moved), pair - 0.1);
            sizes = split.sizes.map((s, i) => (i === index - 1 ? before : i === index ? pair - before : s));
            sizes.forEach((s, i) => children[i].style.setProperty("--share", String(s)));
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            layout.change((l) => L.resizeSplit(l, path, sizes));
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        });
        return el;
      },

      /** An empty window: what to do, centered, with the shortcuts as they're bound now. */
      empty() {
        const hint = document.createElement("div");
        const title = document.createElement("p");
        title.textContent = "No note open";
        const list = document.createElement("dl");
        for (const [label, command] of [
          ["Open note", "quickOpen"],
          ["All commands", "commandBar"],
          ["Split right", "window.splitRight"],
        ]) {
          const key = ctx.commands.shortcut(command);
          if (!key) continue;
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = key;
          list.append(dt, dd);
        }
        const drag = document.createElement("p");
        drag.className = "drag";
        drag.textContent = "or drag a note here";
        hint.append(title, list, drag);
        return hint;
      },
    });
  },
};
