// Embeds' boxes, kept alive. CodeMirror makes a widget's DOM again whenever its decoration comes back
// (the cursor leaves an embed's markdown, the embed scrolls back into view), and an iframe that's made
// again, or moved in the page at all, reloads: a board flashes, a video stops. So what an embed draws
// lives outside the editor and outside the workbench, in one layer of the document, drawn once and
// never moved for as long as its markdown is in the note: the workbench can open, close and rearrange
// tabs and windows around it without touching it. Each editor has a scroller in that layer, laid over
// its own and scrolled with it (both ways: a wheel over a frame scrolls the note). The widget CodeMirror
// manages is an empty slot as tall as the box, and the box is placed over its slot after every update,
// before the page paints. While its markdown shows (no slot), or its tab is hidden, the box is hidden
// with CSS, not removed, so the same iframe shows again, with whatever changed pushed into it. Each box's
// height is remembered across visits (in this browser), so on a note's first paint its slot is already
// as tall as what will fill it, and a box not ready yet holds that height as a quiet card.
import type { EditorView } from "@codemirror/view";
import { blockHeight, measureBlock } from "./live-preview.ts";

interface Live {
  el: HTMLElement;
  /** The slot it shows over, or null while its markdown shows. */
  slot: HTMLElement | null;
  /** Draws it again, when what it shows can't take a change in place. */
  make: () => HTMLElement;
  /** Its height, as last measured. */
  height: number;
}

const HEIGHTS = "common-ink.embed-heights";
/** Boxes' heights from earlier visits, by key: at most this many are kept. */
const KEEP = 300;
let remembered: Map<string, number> | null = null;
const heights = (): Map<string, number> => {
  if (remembered) return remembered;
  try {
    remembered = new Map(Object.entries(JSON.parse(localStorage.getItem(HEIGHTS) ?? "{}") as Record<string, number>));
  } catch {
    remembered = new Map();
  }
  return remembered;
};
let saving = 0;
function remember(key: string, height: number) {
  const all = heights();
  all.delete(key);
  all.set(key, height);
  while (all.size > KEEP) all.delete(all.keys().next().value!);
  clearTimeout(saving);
  saving = window.setTimeout(() => {
    try {
      localStorage.setItem(HEIGHTS, JSON.stringify(Object.fromEntries(all)));
    } catch {
      // Without storage, heights are only kept for this page.
    }
  }, 500);
}

/** A box's height as last seen, this visit or an earlier one; 0 if it's never been drawn here. */
export const rememberedHeight = (key: string): number => heights().get(key) ?? blockHeight(key, 0);

/** Each slot's keeper, for a widget's destroy, which only gets its DOM. */
const owners = new WeakMap<HTMLElement, Lives>();

/** How many frames the editor holds still after a change before its boxes stop being watched. */
const STILL = 10;

/** What a box inherited from the editor's content, where CodeMirror drew widgets: kept so it looks the same here. */
const INHERITED = ["font-family", "font-size", "line-height", "color", "letter-spacing", "white-space", "word-break", "overflow-wrap", "tab-size"];

/** What the app does when an embed's box is used. main.ts sets it. */
export const embedHooks: {
  /** Focus came into a box: its editor's window is the focused one, as if the box were in it. */
  focused(view: EditorView): void;
} = { focused: () => {} };

/** The document's layer for embeds' boxes: above the editors, below menus, the command bar and dialogs. */
let appLayer: HTMLElement | null = null;
function documentLayer(): HTMLElement {
  if (appLayer?.isConnected) return appLayer;
  const layer = (appLayer = document.createElement("div"));
  layer.className = "embed-layer";
  document.body.append(layer);
  // While something is dragged in from outside the boxes (a tab, a note, a file), they let it through to
  // the window under them, which shows where it will land. A drag inside a box (a board's card) stays its own.
  const through = (on: boolean) => layer.classList.toggle("is-passing", on);
  document.addEventListener("dragstart", (e) => through(!layer.contains(e.target as Node)), true);
  document.addEventListener("dragenter", (e) => {
    if (!e.relatedTarget && e.dataTransfer?.types.includes("Files")) through(true);
  }, true);
  // Dragged off the page: a file's drag ends there (a tab's ends with dragend).
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget && e.dataTransfer?.types.includes("Files")) through(false);
  }, true);
  for (const end of ["dragend", "drop"]) document.addEventListener(end, () => through(false), true);
  return layer;
}

export class Lives {
  private lives = new Map<string, Live>();
  /** Laid over the editor's scroller, the same size and scrolled with it; the boxes are in its content. */
  private scroller: HTMLElement;
  private layer: HTMLElement;
  /** Holds the boxes, in the editor's theme classes, so the styles extensions scope to the editor apply. */
  private themed: HTMLElement;
  private shown = { top: NaN, left: NaN, width: NaN, height: NaN };
  private watching = 0;
  private still = 0;
  private resized: Pick<ResizeObserver, "observe" | "unobserve" | "disconnect"> = typeof ResizeObserver === "undefined" ? { observe() {}, unobserve() {}, disconnect() {} } : new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      if (entry.target === this.view.dom) {
        changed = true;
        continue;
      }
      const key = this.keyOfBox(entry.target as HTMLElement);
      const live = key !== null ? this.lives.get(key) : undefined;
      if (!live || !live.el.isConnected) continue;
      const height = live.el.offsetHeight;
      if (!height || height === live.height) continue;
      live.height = height;
      measureBlock(key!, live.el);
      // Only what's ready is remembered: a box still waiting holds the remembered height already.
      if (!live.el.querySelector("[data-pending]") && !live.el.matches("[data-pending]")) remember(key!, height);
      if (live.slot) live.slot.style.height = `${height}px`;
      changed = true;
    }
    if (changed) {
      this.view.requestMeasure();
      this.place();
    }
  });

  /** A box that becomes ready: remember its height now, whether or not its size changed as it did. */
  private ready = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
    for (const r of records) {
      const box = (r.target as HTMLElement).closest<HTMLElement>("[data-live]");
      const key = box && this.keyOfBox(box);
      const live = key ? this.lives.get(key) : undefined;
      if (!live || live.el.matches("[data-pending]") || live.el.querySelector("[data-pending]")) continue;
      live.height = live.el.offsetHeight || live.height;
      if (live.height) remember(key!, live.height);
      if (live.slot && live.height) live.slot.style.height = `${live.height}px`;
    }
  });

  constructor(private view: EditorView) {
    this.scroller = document.createElement("div");
    this.scroller.className = "embed-scroller";
    this.layer = document.createElement("div");
    this.layer.className = "embed-content";
    this.themed = document.createElement("div");
    this.themed.className = "embed-themes";
    this.layer.append(this.themed);
    this.scroller.append(this.layer);
    documentLayer().append(this.scroller);
    this.ready?.observe(this.layer, { subtree: true, attributes: true, attributeFilter: ["data-pending"] });
    // Scrolled together: the note's own scrolling, and a wheel over a frame (which scrolls this layer).
    view.scrollDOM.addEventListener("scroll", this.fromEditor, { passive: true });
    this.scroller.addEventListener("scroll", this.fromLayer, { passive: true });
    // Focus in a box (a click on its button, into its frame) is focus in its editor's window.
    this.scroller.addEventListener("focusin", () => embedHooks.focused(this.view));
    // The editor moves or resizes (a tab hidden or shown, a split, a panel): place everything again.
    this.resized.observe(view.dom);
  }

  /** Until this time, the layer's scroll events are its following the editor's, not a wheel over a frame. */
  private following = 0;

  /** The note scrolled: the layer follows now, and the boxes are placed again once layout settles. */
  private fromEditor = () => {
    this.follow();
    this.settle();
  };

  /** Scroll the layer as the editor is scrolled, as tall and wide as what it scrolls. */
  private follow() {
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth } = this.view.scrollDOM;
    // As tall as the editor's content (which grows as CodeMirror draws more), so it can follow all the way.
    if (this.layer.offsetHeight < scrollHeight) this.layer.style.height = `${scrollHeight}px`;
    if (this.layer.offsetWidth < scrollWidth) this.layer.style.width = `${scrollWidth}px`;
    if (this.scroller.scrollTop !== scrollTop || this.scroller.scrollLeft !== scrollLeft) {
      this.following = performance.now() + 100;
      this.scroller.scrollTop = scrollTop;
      this.scroller.scrollLeft = scrollLeft;
    }
  }

  /**
   * Place everything again in the next frame, when layout is settled: a placement made in the middle
   * of an update (the editor scrolling to keep the cursor in view, say) is set right.
   */
  settle() {
    if (this.settling || !this.lives.size || typeof requestAnimationFrame === "undefined") return;
    this.settling = requestAnimationFrame(() => {
      this.settling = 0;
      this.place();
    });
  }
  private settling = 0;

  private fromLayer = () => {
    // Its own following of the editor (maybe cut short, if it was shorter): nothing to send back.
    if (performance.now() < this.following) return;
    const { scrollTop, scrollLeft } = this.scroller;
    if (this.view.scrollDOM.scrollTop !== scrollTop) this.view.scrollDOM.scrollTop = scrollTop;
    if (this.view.scrollDOM.scrollLeft !== scrollLeft) this.view.scrollDOM.scrollLeft = scrollLeft;
  };

  /**
   * For a few frames after anything happens: if the editor moved on the page without resizing (something
   * above it came or went), place the boxes again. It stops once the editor holds still for STILL frames,
   * and never runs for an editor with no boxes: idle, nothing runs each frame.
   */
  private watch() {
    this.still = 0;
    if (this.watching || !this.lives.size || typeof requestAnimationFrame === "undefined") return;
    const tick = () => {
      if (!this.lives.size || !this.view.dom.isConnected || ++this.still > STILL) return void (this.watching = 0);
      const r = this.view.scrollDOM.getBoundingClientRect();
      if (r.top !== this.shown.top || r.left !== this.shown.left || r.width !== this.shown.width || r.height !== this.shown.height) this.place();
      this.watching = requestAnimationFrame(tick);
    };
    this.watching = requestAnimationFrame(tick);
  }

  /**
   * The slot for the box with this key: kept from before (given `take` to show what changed, or drawn
   * again with `make` if it can't), or drawn now.
   */
  slot(key: string, make: () => HTMLElement, take?: (el: HTMLElement) => boolean): HTMLElement {
    let live = this.lives.get(key);
    if (live && take && !take(live.el)) this.redraw(key, live, make);
    if (!live) {
      const el = make();
      live = { el, slot: null, make, height: rememberedHeight(key) || Number(el.dataset.estimate) || 0 };
      if (live.height) el.style.setProperty("--embed-height", `${live.height}px`);
      el.dataset.live = key;
      this.themed.append(el);
      this.resized.observe(el);
      this.lives.set(key, live);
    }
    live.make = make;
    const slot = document.createElement("div");
    slot.className = "cm-embed-slot";
    slot.dataset.live = key;
    if (live.height) slot.style.height = `${live.height}px`;
    owners.set(slot, this);
    live.slot = slot;
    return slot;
  }

  /** A slot is gone (its markdown shows, or it scrolled away): its box hides, and waits. */
  let(key: string, slot: HTMLElement) {
    const live = this.lives.get(key);
    if (live?.slot === slot) {
      live.slot = null;
      this.place();
    }
  }

  /** Show a change in a kept box, or draw it again if it can't take it. */
  refresh(key: string, take: (el: HTMLElement) => boolean) {
    const live = this.lives.get(key);
    if (live && !take(live.el)) this.redraw(key, live, live.make);
  }

  /** The key a slot is for. */
  keyOf(slot: HTMLElement): string | null {
    return slot.dataset.live ?? null;
  }

  /** The slot a box shows over now, if it shows. */
  slotOf(el: HTMLElement): HTMLElement | null {
    const key = this.keyOfBox(el);
    const slot = key !== null ? this.lives.get(key)?.slot : null;
    return slot?.isConnected ? slot : null;
  }

  /**
   * Lay the scroller over the editor's, and put each box over its slot, or hide it while it has none or
   * its editor isn't on show. Reads layout first, then writes.
   */
  place() {
    this.watch();
    const editor = this.view.scrollDOM;
    const r = editor.getBoundingClientRect();
    const on = this.view.dom.isConnected && r.width > 0 && r.height > 0;
    const top = r.top + editor.clientTop;
    const left = r.left + editor.clientLeft;
    const spots = [...this.lives.values()].map((live) => {
      const s = on && live.slot?.isConnected ? live.slot.getBoundingClientRect() : null;
      const at = s && (s.width > 0 || s.height > 0) ? { top: s.top - top + editor.scrollTop, left: s.left - left + editor.scrollLeft, width: s.width } : null;
      return { live, at };
    });
    const size = { width: editor.clientWidth, height: editor.clientHeight, inner: editor.scrollHeight, innerWidth: editor.scrollWidth };
    this.shown = { top: r.top, left: r.left, width: r.width, height: r.height };
    // The editor's theme classes, so the styles extensions give their embeds (scoped to the editor) apply here too.
    const themed = `embed-themes ${[...this.view.dom.classList].filter((c) => c !== "cm-editor" && c !== "cm-focused").join(" ")}`;
    if (this.themed.className !== themed) {
      this.themed.className = themed;
      // And the text the editor's content gives what's in it (a widget's DOM was in it), as a box there had.
      const font = getComputedStyle(this.view.contentDOM);
      for (const p of INHERITED) this.themed.style.setProperty(p, font.getPropertyValue(p));
    }
    const box = this.scroller.style;
    box.visibility = on ? "" : "hidden";
    box.top = `${top}px`;
    box.left = `${left}px`;
    box.width = `${size.width}px`;
    box.height = `${size.height}px`;
    this.layer.style.height = `${size.inner}px`;
    this.layer.style.width = `${size.innerWidth}px`;
    this.follow();
    for (const { live, at } of spots) {
      live.el.classList.toggle("is-hidden", !at);
      if (!at) continue;
      const style = live.el.style;
      const [t, l, w] = [`${at.top}px`, `${at.left}px`, `${at.width}px`];
      if (style.top !== t) style.top = t;
      if (style.left !== l) style.left = l;
      if (style.width !== w) style.width = w;
    }
  }

  /** Let go of the boxes `keep` says no to: their markdown isn't in the note any more. */
  prune(keep: (key: string) => boolean) {
    for (const [key, live] of this.lives) {
      if (keep(key)) continue;
      this.resized.unobserve(live.el);
      live.el.remove();
      this.lives.delete(key);
    }
  }

  destroy() {
    cancelAnimationFrame(this.watching);
    cancelAnimationFrame(this.settling);
    this.resized.disconnect();
    this.ready?.disconnect();
    this.view.scrollDOM.removeEventListener("scroll", this.fromEditor);
    this.scroller.remove();
    this.lives.clear();
  }

  private redraw(key: string, live: Live, make: () => HTMLElement) {
    this.resized.unobserve(live.el);
    const el = make();
    el.dataset.live = key;
    live.el.replaceWith(el);
    live.el = el;
    this.resized.observe(el);
  }

  private keyOfBox(el: HTMLElement): string | null {
    return el.dataset.live ?? null;
  }
}

const byView = new WeakMap<EditorView, Lives>();

/** The keeper of an editor's boxes (made the first time), or, given a slot, the one it belongs to. */
export function livesOf(of: EditorView | HTMLElement): Lives {
  if (!("state" in of)) return owners.get(of)!;
  let lives = byView.get(of);
  if (!lives) byView.set(of, (lives = new Lives(of)));
  return lives;
}

/** Forget an editor's boxes, when it's gone. */
export function dropLives(view: EditorView) {
  byView.get(view)?.destroy();
  byView.delete(view);
}
