// Embeds' boxes, kept alive. CodeMirror makes a widget's DOM again whenever its decoration comes back
// (the cursor leaves an embed's markdown, the embed scrolls back into view), and an iframe made again
// reloads: a board flashes, a video stops. So what an embed draws lives outside the editor's content,
// in a layer of the editor's scroller, drawn once and kept for as long as its markdown is in the note.
// The widget CodeMirror manages is an empty slot as tall as the box, and the box is placed over its
// slot after every update, before the page paints. While its markdown shows (no slot), the box is
// hidden, not removed, so the same iframe shows again, with whatever changed pushed into it. Each box's
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

export class Lives {
  private lives = new Map<string, Live>();
  private layer: HTMLElement;
  private resized: Pick<ResizeObserver, "observe" | "unobserve" | "disconnect"> = typeof ResizeObserver === "undefined" ? { observe() {}, unobserve() {}, disconnect() {} } : new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
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
    this.layer = document.createElement("div");
    this.layer.className = "cm-embed-layer";
    view.scrollDOM.append(this.layer);
    this.ready?.observe(this.layer, { subtree: true, attributes: true, attributeFilter: ["data-pending"] });
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
      this.layer.append(el);
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

  /** Put each box over its slot, or hide it while it has none. Reads layout once, then writes. */
  place() {
    const scroller = this.view.scrollDOM;
    const origin = scroller.getBoundingClientRect();
    const spots = [...this.lives.values()].map((live) => {
      const r = live.slot?.isConnected ? live.slot.getBoundingClientRect() : null;
      return { live, at: r && { top: r.top - origin.top + scroller.scrollTop, left: r.left - origin.left + scroller.scrollLeft, width: r.width } };
    });
    for (const { live, at } of spots) {
      live.el.classList.toggle("is-hidden", !at);
      if (!at) continue;
      const style = live.el.style;
      const [top, left, width] = [`${at.top}px`, `${at.left}px`, `${at.width}px`];
      if (style.top !== top) style.top = top;
      if (style.left !== left) style.left = left;
      if (style.width !== width) style.width = width;
    }
  }

  /** Let go of the boxes whose markdown isn't in the note any more. */
  prune(keys: ReadonlySet<string>) {
    for (const [key, live] of this.lives) {
      if (keys.has(key)) continue;
      this.resized.unobserve(live.el);
      live.el.remove();
      this.lives.delete(key);
    }
  }

  destroy() {
    this.resized.disconnect();
    this.ready?.disconnect();
    this.layer.remove();
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
