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
//
// A video playing in a box (media.ts) floats instead, while its note is out of sight: its tab hidden, its
// slot scrolled away, or its tab closed. Floating is only CSS (position: fixed, in a small window with a
// bar to drag it by), so the video plays on; it docks again when its slot is on show. A box playing when
// its editor closes is kept, its scroller with it, until the note opens again (and takes them back) or it's
// stopped.
import type { EditorView } from "@codemirror/view";
import type { FilePath } from "../../worker/src/files.ts";
import { editorFile } from "./editor-file.ts";
import { blockHeight, measureBlock } from "./live-preview.ts";
import { endMediaIn, letGoMedia, mediaHooks, mediaIn, onMedia, type MediaSession } from "./media.ts";

interface Live {
  el: HTMLElement;
  /** The slot it shows over, or null while its markdown shows. */
  slot: HTMLElement | null;
  /** Draws it again, when what it shows can't take a change in place. */
  make: () => HTMLElement;
  /** Its height, as last measured. */
  height: number;
  /** Floating in a small window of its own, while it plays out of sight. */
  floating: boolean;
  /** Its floating window was closed: it stays hidden until it's on show again. */
  closed: boolean;
  /** Whether it was on show when last placed. */
  seen: boolean;
  /** Whether what plays in it was playing when last placed. */
  played: boolean;
  /** The floating window's bar, made the first time it floats. */
  bar?: HTMLElement;
  /** Where its floating window was put, from the page's bottom right corner: it shows there, or as near as the page allows. */
  corner?: Corner;
}

interface Corner {
  right: number;
  bottom: number;
}

const FLOAT = "common-ink.media-float";
/** Where a floating window goes first: above the mini player. Each more window floating goes this much above the last. */
const HOME: Corner = { right: 16, bottom: 88 };
const STACK = 220;
/** How far an arrow key moves a floating window (with Shift, four times as far). */
const NUDGE = 16;

/** Where a floating window goes: where the last one was dragged to, or above the mini player. */
function floatCorner(): Corner {
  try {
    const c = JSON.parse(localStorage.getItem(FLOAT) ?? "null") as Corner | null;
    if (c && Number.isFinite(c.right) && Number.isFinite(c.bottom)) return { right: c.right, bottom: c.bottom };
  } catch {
    // Without storage, it goes to the usual place.
  }
  return HOME;
}
function keepCorner(c: Corner | null) {
  try {
    if (c) localStorage.setItem(FLOAT, JSON.stringify(c));
    else localStorage.removeItem(FLOAT);
  } catch {
    // Kept for this page only.
  }
}

/**
 * A floating window's spot, kept on the page: all of it, or, on a page smaller than it, its top left
 * (where its bar is). Whatever asked for the spot (a drag, a spot kept from a bigger window, the stack).
 */
export function onPage(c: Corner, size: { width: number; height: number }, page: { width: number; height: number }): Corner {
  return { right: Math.min(Math.max(c.right, 0), page.width - size.width), bottom: Math.min(Math.max(c.bottom, 0), page.height - size.height) };
}

/** Every floating window, in the order they started floating: each new one goes above the last. */
const floating = new Set<HTMLElement>();

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

/** What a box inherited from the editor's scroller, where boxes were before they moved to this layer: kept so it looks the same. */
const INHERITED = ["font-family", "font-size", "color", "letter-spacing"];

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
  /** The editor it keeps boxes for, or null once that's closed and only playing boxes are kept. */
  private view: EditorView | null = null;
  /** The note its editor shows, so the note opening again can take its boxes back. */
  note: FilePath | null = null;
  /** Where a box's markdown is in the note now, by key: for Back to note. embeds.ts sets it. */
  locate: (key: string) => number | null = () => null;
  /** Laid over the editor's scroller, the same size and scrolled with it; the boxes are in its content. */
  private scroller: HTMLElement;
  private layer: HTMLElement;
  /** Holds the boxes, in the editor's theme classes, so the styles extensions scope to the editor apply. */
  private themed: HTMLElement;
  private shown = { top: NaN, left: NaN, width: NaN, height: NaN };
  private watching = 0;
  private still = 0;
  /** Watching the boxes' sizes again on the next frame, after they were placed as the editor resized. */
  private placing = 0;
  private resized: Pick<ResizeObserver, "observe" | "unobserve" | "disconnect"> = typeof ResizeObserver === "undefined" ? { observe() {}, unobserve() {}, disconnect() {} } : new ResizeObserver((entries) => {
    let changed = false;
    let editor = false;
    for (const entry of entries) {
      if (entry.target === this.view?.dom) {
        editor = true;
        continue;
      }
      const key = this.keyOfBox(entry.target as HTMLElement);
      const live = key !== null ? this.lives.get(key) : undefined;
      // A floating window's size is its own, not the box's in the note.
      if (!live || !live.el.isConnected || live.floating) continue;
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
      this.view?.requestMeasure();
      this.place();
    }
    if (editor) this.placeUnwatched();
  });

  /**
   * The editor changed size, and nothing placed the boxes for it yet: they go over their slots now,
   * before the page is painted. Their new widths would be seen in a second delivery of this observer,
   * which the browser reports as a loop, so their sizes aren't watched until the next frame (where a
   * box that grew or shrank as it narrowed is measured as it's watched again).
   */
  private placeUnwatched() {
    for (const live of this.lives.values()) this.resized.unobserve(live.el);
    this.place();
    cancelAnimationFrame(this.placing);
    this.placing = requestAnimationFrame(() => {
      this.placing = 0;
      for (const live of this.lives.values()) if (live.el.isConnected) this.resized.observe(live.el);
    });
  }

  /** A box that becomes ready: remember its height now, whether or not its size changed as it did. */
  private ready = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
    for (const r of records) {
      const box = (r.target as HTMLElement).closest<HTMLElement>("[data-live]");
      const key = box && this.keyOfBox(box);
      const live = key ? this.lives.get(key) : undefined;
      if (!live || live.floating || live.el.matches("[data-pending]") || live.el.querySelector("[data-pending]")) continue;
      live.height = live.el.offsetHeight || live.height;
      if (live.height) remember(key!, live.height);
      if (live.slot && live.height) live.slot.style.height = `${live.height}px`;
    }
  });

  constructor(view: EditorView) {
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
    // A wheel over a frame scrolls this layer: the note scrolls with it.
    this.scroller.addEventListener("scroll", this.fromLayer, { passive: true });
    // Focus in a box (a click on its button, into its frame) is focus in its editor's window.
    this.scroller.addEventListener("focusin", () => this.view && embedHooks.focused(this.view));
    this.adopt(view);
    all.add(this);
  }

  /** Keep boxes for this editor: a new one, or one showing the note again after its last closed. */
  adopt(view: EditorView) {
    this.view = view;
    this.note = view.state.facet(editorFile);
    // Scrolled together: the note's own scrolling, and a wheel over a frame.
    view.scrollDOM.addEventListener("scroll", this.fromEditor, { passive: true });
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
    if (!this.view) return;
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
    if (!this.view || performance.now() < this.following) return;
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
    if (this.watching || !this.view || !this.lives.size || typeof requestAnimationFrame === "undefined") return;
    const tick = () => {
      const view = this.view;
      if (!view || !this.lives.size || !view.dom.isConnected || ++this.still > STILL) return void (this.watching = 0);
      const r = view.scrollDOM.getBoundingClientRect();
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
      live = { el, slot: null, make, height: rememberedHeight(key) || Number(el.dataset.estimate) || 0, floating: false, closed: false, seen: false, played: false };
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
   * Lay the scroller over the editor's, and put each box over its slot; or, while it has none or it's out
   * of sight, hide it, or float it if it's a video playing. Reads layout first, then writes.
   */
  place(watch = true) {
    // A placing for something around the editors (a clock in the status bar) doesn't start the watch,
    // or what changes every second would keep it running.
    if (watch) this.watch();
    const view = this.view;
    const editor = view?.scrollDOM;
    const r = editor?.getBoundingClientRect();
    const on = !!view && !!editor && !!r && view.dom.isConnected && r.width > 0 && r.height > 0;
    const top = on ? r.top + editor.clientTop : 0;
    const left = on ? r.left + editor.clientLeft : 0;
    const spots = [...this.lives.values()].map((live) => {
      const s = on && live.slot?.isConnected ? live.slot.getBoundingClientRect() : null;
      const at = on && s && (s.width > 0 || s.height > 0) ? { top: s.top - top + editor.scrollTop, left: s.left - left + editor.scrollLeft, width: s.width } : null;
      // On show: some of it is inside the editor's window.
      const seen = !!at && !!s && s.bottom > r!.top && s.top < r!.bottom;
      return { live, at, seen };
    });
    // Where the editor was, shown or not (a hidden tab's is all zeros), for the watch to tell it moved.
    if (r) this.shown = { top: r.top, left: r.left, width: r.width, height: r.height };
    if (view && editor && on) {
      const size = { width: editor.clientWidth, height: editor.clientHeight, inner: editor.scrollHeight, innerWidth: editor.scrollWidth };
      // The editor's theme classes, so the styles extensions give their embeds (scoped to the editor) apply here too.
      const themed = `embed-themes ${[...view.dom.classList].filter((c) => c !== "cm-editor" && c !== "cm-focused").join(" ")}`;
      if (this.themed.className !== themed) {
        this.themed.className = themed;
        // And the text the editor's scroller gives what's in it, as a box had when it was in there.
        const font = getComputedStyle(editor);
        for (const p of INHERITED) this.themed.style.setProperty(p, font.getPropertyValue(p));
        // A line height given as a number scales with each element's own font size: kept as that number, not
        // as the pixels it comes to here (or a time in a bigger font would be squeezed into a line of text's).
        const [line, fontSize] = [parseFloat(font.lineHeight), parseFloat(font.fontSize)];
        if (font.lineHeight !== "normal" && line && fontSize) this.themed.style.lineHeight = String(Math.round((line / fontSize) * 1000) / 1000);
      }
      const box = this.scroller.style;
      box.visibility = "";
      box.top = `${top}px`;
      box.left = `${left}px`;
      box.width = `${size.width}px`;
      box.height = `${size.height}px`;
      this.layer.style.height = `${size.inner}px`;
      this.layer.style.width = `${size.innerWidth}px`;
      this.follow();
    } else this.scroller.style.visibility = "hidden";
    const when = mediaHooks.whenHidden();
    for (const { live, at, seen } of spots) {
      const media = mediaIn(live.el);
      // Its window closed, it stays closed, until it's on show again or it's played again (the mini player).
      if (seen || (media?.playing && !live.played)) live.closed = false;
      live.played = !!media?.playing;
      if (!seen && media?.playing && !live.floating) {
        // Out of sight while it plays: a video floats; with "pause", anything pauses as it goes.
        if (when === "pause" && live.seen) media.pause();
        else if (when === "float" && media.kind === "video" && !live.closed) live.floating = true;
      }
      if (seen && live.floating) this.dock(live);
      live.seen = seen;
      if (live.floating) {
        this.float(live);
        continue;
      }
      live.el.classList.toggle("is-hidden", !at);
      if (!at) continue;
      const style = live.el.style;
      const [t, l, w] = [`${at.top}px`, `${at.left}px`, `${at.width}px`];
      if (style.top !== t) style.top = t;
      if (style.left !== l) style.left = l;
      if (style.width !== w) style.width = w;
    }
  }

  /** Show a box in its floating window: the same element, only styled so; its bar made the first time. */
  private float(live: Live) {
    const key = this.keyOfBox(live.el)!;
    const el = live.el;
    if (!floating.has(el)) {
      // Each new window goes above the ones already floating.
      const base = floatCorner();
      live.corner = { right: base.right, bottom: base.bottom + [...floating].filter((f) => f.isConnected).length * STACK };
      floating.add(el);
    }
    if (!live.bar) live.bar = this.floatBar(key, live);
    if (live.bar.parentNode !== el) el.prepend(live.bar);
    const media = mediaIn(el);
    const name = this.note ? this.note.replace(/\.md$/, "").split("/").pop()! : "";
    const title = live.bar.querySelector<HTMLElement>(".title")!;
    const note = live.bar.querySelector<HTMLElement>(".note")!;
    if (title.textContent !== (media?.title ?? "")) title.textContent = media?.title ?? "";
    if (note.textContent !== name) note.textContent = name;
    el.classList.remove("is-hidden");
    el.classList.add("is-floating");
    this.pin(live);
  }

  /** Put a floating window where it was put, kept on the page. */
  private pin(live: Live) {
    const at = onPage(live.corner!, { width: live.el.offsetWidth, height: live.el.offsetHeight }, { width: innerWidth, height: innerHeight });
    const [r, b] = [`${at.right}px`, `${at.bottom}px`];
    if (live.el.style.right !== r) live.el.style.right = r;
    if (live.el.style.bottom !== b) live.el.style.bottom = b;
  }

  /** Move a floating window to a spot (kept on the page), and float the next one there. */
  private moveFloat(live: Live, to: Corner) {
    live.corner = onPage(to, { width: live.el.offsetWidth, height: live.el.offsetHeight }, { width: innerWidth, height: innerHeight });
    this.pin(live);
  }

  /** Floating windows back where they first go, stacked above the mini player; the next one floats there too. */
  resetFloats(n: { stacked: number }) {
    for (const live of this.lives.values()) {
      if (!live.floating) continue;
      live.corner = { right: HOME.right, bottom: HOME.bottom + n.stacked++ * STACK };
      this.pin(live);
    }
  }

  /** Back in the note, over its slot. */
  private dock(live: Live) {
    live.floating = false;
    floating.delete(live.el);
    live.el.classList.remove("is-floating");
    live.el.style.right = "";
    live.el.style.bottom = "";
  }

  /** A floating window's bar: what plays and which note it's from, Back to note, and Stop and close. */
  private floatBar(key: string, live: Live): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "media-float-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Floating video: drag it, or move it with the arrow keys; Home puts it back in the corner");
    bar.title = "Drag to move · double-click to put it back in the corner";
    // Reached with Tab: the arrow keys move it, as a drag does.
    bar.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "label";
    const title = document.createElement("span");
    title.className = "title";
    const note = document.createElement("span");
    note.className = "note";
    label.append(title, note);
    const button = (text: string, name: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = name;
      b.setAttribute("aria-label", name);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
      });
      return b;
    };
    bar.append(label, button("↩", "Back to note", () => void this.back(key)), button("✕", "Stop and close", () => this.close(key)));
    // Dragged by its bar: the pointer stays with the bar even over the frame.
    bar.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      // From where it shows, which may be nearer than where it was put, on a smaller page.
      const shown = live.el.getBoundingClientRect();
      const from = { x: e.clientX, y: e.clientY, right: innerWidth - shown.right, bottom: innerHeight - shown.bottom };
      const move = (m: PointerEvent) => this.moveFloat(live, { right: from.right - (m.clientX - from.x), bottom: from.bottom - (m.clientY - from.y) });
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
        keepCorner(live.corner!);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });
    bar.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("button")) resetFloats();
    });
    bar.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Home") {
        e.preventDefault();
        return resetFloats();
      }
      const by = e.shiftKey ? NUDGE * 4 : NUDGE;
      const step = ({ ArrowLeft: [by, 0], ArrowRight: [-by, 0], ArrowUp: [0, by], ArrowDown: [0, -by] } as Record<string, [number, number]>)[e.key];
      if (!step) return;
      e.preventDefault();
      const shown = live.el.getBoundingClientRect();
      this.moveFloat(live, { right: innerWidth - shown.right + step[0], bottom: innerHeight - shown.bottom + step[1] });
      keepCorner(live.corner!);
    });
    return bar;
  }

  /** Back to note: show its tab, or open the note again if it was closed, and scroll to it. */
  async back(key: string) {
    if (!this.view && this.note) await mediaHooks.open(this.note);
    if (this.view) mediaHooks.reveal(this.view, this.locate(key));
  }

  /** Stop and close a floating window: it pauses where it is, and waits in its note, or goes if that's closed. */
  close(key: string) {
    const live = this.lives.get(key);
    if (!live) return;
    mediaIn(live.el)?.pause();
    this.dock(live);
    live.closed = true;
    if (!this.view) this.forget(key, live);
    this.place();
    this.letGoIfDone();
  }

  /** Let go of the boxes `keep` says no to: their markdown isn't in the note any more. */
  prune(keep: (key: string) => boolean) {
    for (const [key, live] of this.lives) if (!keep(key)) this.forget(key, live);
  }

  private forget(key: string, live: Live) {
    this.resized.unobserve(live.el);
    floating.delete(live.el);
    endMediaIn(live.el);
    live.el.remove();
    this.lives.delete(key);
  }

  /**
   * Its editor closed: keep what's playing (floating, if it's a video), and let go of the rest. Kept, it
   * waits for the note to open again. With "pause", nothing is kept.
   */
  release() {
    const view = this.view;
    if (!view) return;
    const when = mediaHooks.whenHidden();
    for (const [key, live] of this.lives) {
      const media = mediaIn(live.el);
      if (!media?.playing || when === "pause") {
        this.forget(key, live);
        continue;
      }
      live.slot = null;
      if (media.kind === "video" && when === "float" && !live.closed) live.floating = true;
    }
    cancelAnimationFrame(this.watching);
    this.watching = 0;
    view.scrollDOM.removeEventListener("scroll", this.fromEditor);
    this.resized.unobserve(view.dom);
    this.view = null;
    if (!this.lives.size) return this.destroy();
    this.place();
  }

  /** Kept after its editor closed, with nothing playing, paused to play on, or floating any more: let go of it all. */
  letGoIfDone() {
    if (this.view) return;
    for (const [key, live] of this.lives) {
      const media = mediaIn(live.el);
      if (!live.floating && !media?.playing && !media?.held) this.forget(key, live);
    }
    if (!this.lives.size) this.destroy();
  }

  destroy() {
    cancelAnimationFrame(this.watching);
    cancelAnimationFrame(this.settling);
    this.resized.disconnect();
    this.ready?.disconnect();
    this.view?.scrollDOM.removeEventListener("scroll", this.fromEditor);
    for (const [key, live] of this.lives) this.forget(key, live);
    this.scroller.remove();
    all.delete(this);
  }

  private redraw(key: string, live: Live, make: () => HTMLElement) {
    this.resized.unobserve(live.el);
    endMediaIn(live.el);
    const el = make();
    el.dataset.live = key;
    live.el.replaceWith(el);
    live.el = el;
    this.resized.observe(el);
  }

  private keyOfBox(el: HTMLElement): string | null {
    return el.dataset.live ?? null;
  }

  /** Whether this box, by this key, is one of its own. */
  holds(key: string, box: HTMLElement) {
    return this.lives.get(key)?.el === box;
  }

  /** Whether it's kept only for what plays, its editor closed. */
  get orphaned() {
    return !this.view;
  }
}

const byView = new WeakMap<EditorView, Lives>();
/** Every keeper, its editor open or not. */
const all = new Set<Lives>();

/** Put every floating window back above the mini player, and forget the spot they were dragged to. */
export function resetFloats() {
  keepCorner(null);
  const n = { stacked: 0 };
  for (const lives of all) lives.resetFloats(n);
}

// The page resized: floating windows stay on it (and go back toward where they were put, as it grows).
if (typeof addEventListener !== "undefined") addEventListener("resize", () => all.forEach((l) => l.place()));

/**
 * The page's layout changed around the editors (a window split, closed or resized, the side bar shown
 * or hidden, a border dragged): the boxes go over their slots before the page is painted. Done in the
 * mutation's microtask, the boxes' new sizes are seen with the editors' in the next resize delivery,
 * not in a second one, which the browser would report as a loop. What changes inside an editor, or
 * among the boxes themselves, isn't a change around them.
 */
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined")
  new MutationObserver((records) => {
    if (!all.size || !records.some((r) => r.target instanceof Element && !r.target.closest(".cm-editor, .embed-layer"))) return;
    for (const lives of all) lives.place(false);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });

// What plays changed: a video that started or stopped may float, dock or go.
if (typeof queueMicrotask !== "undefined")
  onMedia(() => {
    for (const lives of [...all]) {
      lives.place();
      lives.letGoIfDone();
    }
  });

/** The keeper of an editor's boxes, or, given a slot, the one it belongs to. */
export function livesOf(of: EditorView | HTMLElement): Lives {
  if (!("state" in of)) return owners.get(of)!;
  return byView.get(of) ?? attachLives(of);
}

/**
 * An editor's keeper, as its plugin starts: made, or taken back. Its plugin made again (the editor
 * reconfigured) takes back what it kept; a new editor for a note takes back what was kept playing when
 * the note's last editor closed. A closed editor's own calls after that (a stray event) take nothing.
 */
export function attachLives(view: EditorView): Lives {
  const had = byView.get(view);
  if (had && !had.orphaned) return had;
  const note = view.state.facet(editorFile);
  const kept = had && all.has(had) && had.orphaned ? had : note ? [...all].find((l) => l.orphaned && l.note === note) : undefined;
  kept?.adopt(view);
  const lives = kept ?? new Lives(view);
  byView.set(view, lives);
  return lives;
}

/** An editor is gone (or its plugin is, for now): let go of its boxes, but what's playing. */
export function dropLives(view: EditorView) {
  byView.get(view)?.release();
}

/** The keeper and key of the box `el` is drawn in. */
function boxOf(el: HTMLElement): { lives: Lives; key: string } | null {
  const box = el.closest<HTMLElement>(".embed-themes > [data-live]");
  const key = box?.dataset.live;
  const lives = key ? [...all].find((l) => l.holds(key, box!)) : undefined;
  return lives && key ? { lives, key } : null;
}

/** The note a session plays in. */
export const noteOfMedia = (session: MediaSession): FilePath | null => (session.el && boxOf(session.el)?.lives.note) ?? null;

/** Show the note a session plays in, scrolled to it. */
export function revealMedia(session: MediaSession) {
  const at = session.el && boxOf(session.el);
  if (at) void at.lives.back(at.key);
}

/** Stop a session: it stops (or pauses), and its floating window closes. */
export function stopMedia(session: MediaSession) {
  if (session.stop) session.stop();
  else session.pause();
  letGoMedia(session);
  const at = session.el && boxOf(session.el);
  if (at) at.lives.close(at.key);
}
