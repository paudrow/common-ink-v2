// This device: what the browser the app is open in has, live (its width class, pointer, touch and
// whether it has a keyboard), and its file, .common-ink/users/<you>/devices/<id>/device.json, with
// what was seen here and your overrides (worker/src/devices.ts). A keyboard is assumed on a desktop,
// found elsewhere the first time a key a touch screen's keyboard doesn't send arrives, and kept once
// found. The `device` lever stands in for a phone, a tablet or a laptop, and frames the page to its size.
import { deviceLayoutPath, deviceName, devicePath, deviceText, parseDeviceFile, widthClassOf, atLeast, type DeviceFile, type Facts, type KeyboardChoice, type Override, type WidthClass } from "../../worker/src/devices.ts";
import type { FilePath, Revision, WriteResult } from "../../worker/src/files.ts";

export type Preset = "phone" | "tablet" | "laptop";

/** What the `device` lever stands in for: a size to frame the page to, and what such a device has. */
export const PRESETS: Readonly<Record<Preset, { width: number; height: number; touch: boolean; pointer: "fine" | "coarse"; keyboard: boolean }>> = {
  phone: { width: 375, height: 812, touch: true, pointer: "coarse", keyboard: false },
  tablet: { width: 820, height: 1180, touch: true, pointer: "coarse", keyboard: false },
  laptop: { width: 1440, height: 900, touch: false, pointer: "fine", keyboard: true },
};

/** What `ctx.device` answers about. */
export type Capability = "keyboard" | "width" | "pointer" | "touch";

export interface DeviceIo {
  read(path: FilePath): Promise<{ text: string; revision: Revision }>;
  write(path: FilePath, text: string, base: Revision): Promise<WriteResult>;
}

const ID_KEY = "common-ink.device";

/** This browser's device id, made the first time and kept; null where nothing can be kept, so there's no file to write. */
function deviceId(preset: Preset | null): string | null {
  // A stand-in device keeps a file of its own, so a laptop pretending to be a phone doesn't change the laptop's.
  if (preset) return `lever-${preset}`;
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const mq = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;

/** Keys a phone or tablet sends from its own buttons (volume, media, power), and modifiers pressed alone: no sign of a keyboard. */
const NOT_A_SIGN = /^(Audio|Media|Volume|Browser|Launch|Brightness|Power|Eject|Sleep|WakeUp|Hibernate|Standby|LogOff|Zoom|Mic|Camera|Channel|Color|TV|AppSwitch|Call|EndCall|GoBack|GoHome|Notification|Settings|Info|Guide|Dimmer|Print|Help|Select|Exit|Shift|Control|Alt|Meta|CapsLock|Fn|NumLock|ScrollLock|Symbol|Hyper|Super|OS$|Dead|Unidentified|Process|Compose)/;

/** Keys some on-screen keyboards send too (Gboard's cursor keys, Samsung's arrows), each a hint only, by its kind. */
const HINTS: Array<[string, RegExp]> = [
  ["moving", /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/],
  ["escape", /^Escape$/],
  ["function", /^F\d{1,2}$/],
];

export type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "isComposing" | "isTrusted">;

/**
 * The evidence of a keyboard a touch screen doesn't have, a key press at a time. A character typed
 * outside a text field (no keyboard is on screen there), or a ⌘ or Ctrl chord, proves one. Keys an
 * on-screen keyboard may also send (arrows, Tab, Escape) are hints, and it takes two kinds of them:
 * a phone's cursor keys alone are one kind. Presses made by scripts don't count.
 */
export class KeyEvidence {
  private kinds = new Set<string>();

  /** Whether, with this press, there's a keyboard. */
  note(e: KeyLike, inText: boolean): boolean {
    if (!e.isTrusted || e.isComposing || !e.key || NOT_A_SIGN.test(e.key)) return false;
    const typed = [...e.key].length === 1;
    if (typed && (e.ctrlKey || e.metaKey)) return true;
    if (typed) return !inText;
    const hint = HINTS.find(([, keys]) => keys.test(e.key));
    if (hint) this.kinds.add(hint[0]);
    return this.kinds.size >= 2;
  }
}

const inTextField = (target: EventTarget | null) => target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

/** Minutes, local time, as the file says when it was last seen: "2026-10-05T09:12". */
const minute = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** What the extension runtime reads of the device. */
export type DeviceReader = Pick<Device, "facts" | "override" | "has" | "atLeast" | "why" | "onChange" | "describe">;

export class Device {
  readonly id: string | null;
  readonly path: FilePath | null;
  /** This device's own layout of windows and tabs. */
  readonly layoutPath: FilePath | null;
  readonly preset: Preset | null;
  /** The file as this browser has it: kept in step with device.json, and written when it changes. */
  file: DeviceFile;
  facts: Facts;
  /** A key a touch screen doesn't send was pressed in this page. */
  private found = false;
  private revision: Revision = 0;
  private listeners: Array<(device: Device, was: Facts) => void> = [];
  private writing: Promise<void> = Promise.resolve();
  /**
   * What this tab changed and hasn't written yet, by key: a write puts these on the file as it is then,
   * so two tabs (or you, editing the file) changing different things both keep theirs.
   */
  private pending: { keyboard?: KeyboardChoice; extensions: Map<string, Override | null>; seenKeyboard?: true } = { extensions: new Map() };
  private io: DeviceIo | null = null;

  constructor(o: { me: string | undefined; preset: Preset | null; root?: HTMLElement }) {
    this.preset = o.preset;
    this.id = deviceId(o.preset);
    this.path = o.me && this.id ? devicePath(o.me, this.id) : null;
    this.layoutPath = o.me && this.id ? deviceLayoutPath(o.me, this.id) : null;
    const root = o.root ?? document.documentElement;
    if (o.preset) {
      root.dataset.deviceFrame = o.preset;
      root.style.setProperty("--frame-width", `${PRESETS[o.preset].width}px`);
      root.style.setProperty("--frame-height", `${PRESETS[o.preset].height}px`);
    }
    const width = this.measure();
    this.file = {
      name: o.preset ? `Stand-in ${o.preset} (the device lever)` : deviceName(navigator.userAgent),
      lastSeen: minute(new Date()),
      seen: { width: widthClassOf(width), pointer: this.pointerNow(), touch: this.touchNow(), keyboard: false },
      keyboard: "auto",
      extensions: {},
    };
    this.facts = this.compute(width);
    this.mark(root);
    const update = () => this.refresh();
    const evidence = new KeyEvidence();
    new ResizeObserver(update).observe(document.body);
    for (const q of ["(any-pointer: fine)", "(any-pointer: coarse)"]) matchMedia(q).addEventListener?.("change", update);
    addEventListener(
      "keydown",
      (e) => {
        if (this.found || !evidence.note(e, inTextField(e.target))) return;
        this.found = true;
        if (!this.file.seen.keyboard) {
          this.file.seen.keyboard = true;
          this.pending.seenKeyboard = true;
          void this.save();
        }
        this.refresh();
      },
      { capture: true },
    );
  }

  /** The page's width: the frame's, under the lever. */
  private measure(): number {
    return Math.round(document.body?.getBoundingClientRect().width || innerWidth);
  }

  private pointerNow(): "fine" | "coarse" {
    return this.preset ? PRESETS[this.preset].pointer : mq("(any-pointer: fine)") ? "fine" : "coarse";
  }

  private touchNow(): boolean {
    return this.preset ? PRESETS[this.preset].touch : mq("(any-pointer: coarse)");
  }

  /** A desktop: a pointer that's fine and hovers. Taken to have a keyboard until you say otherwise. */
  private looksLikeDesktop(): boolean {
    return this.preset ? PRESETS[this.preset].keyboard : mq("(pointer: fine) and (hover: hover)");
  }

  private compute(px: number): Facts {
    const choice = this.file.keyboard;
    const keyboard = choice === "yes" || (choice === "auto" && (this.found || this.file.seen.keyboard || this.looksLikeDesktop()));
    return { px, width: widthClassOf(px), pointer: this.pointerNow(), touch: this.touchNow(), keyboard };
  }

  /** What CSS goes by: html[data-width="compact"], [data-keyboard], [data-touch]. */
  private mark(root = document.documentElement) {
    root.dataset.width = this.facts.width;
    root.dataset.pointer = this.facts.pointer;
    root.toggleAttribute("data-touch", this.facts.touch);
    root.toggleAttribute("data-keyboard", this.facts.keyboard);
  }

  /** Work the facts out again, and tell listeners if any changed (unless this is the start, where nothing changed for anyone yet). */
  private refresh(quiet = false) {
    const was = this.facts;
    const now = this.compute(this.measure());
    this.facts = now;
    if (now.width === was.width && now.pointer === was.pointer && now.touch === was.touch && now.keyboard === was.keyboard) return;
    this.mark();
    if (!quiet) for (const fn of this.listeners) fn(this, was);
  }

  has(capability: "keyboard" | "touch"): boolean {
    return capability === "keyboard" ? this.facts.keyboard : this.facts.touch;
  }

  atLeast(min: WidthClass): boolean {
    return atLeast(this.facts.width, min);
  }

  /** After the width class, the pointer, touch or the keyboard changes. */
  onChange(fn: (device: Device, was: Facts) => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((x) => x !== fn));
  }

  /** Why the app thinks what it does about one capability, in words. */
  why(capability: Capability): string {
    const lever = "the device lever stands in for a " + this.preset;
    if (capability === "width") return `the window is ${this.facts.px}px wide`;
    if (capability === "pointer") return this.preset ? lever : this.facts.pointer === "fine" ? "a mouse or trackpad is there" : "there's no mouse or trackpad";
    if (capability === "touch") return this.preset ? lever : this.facts.touch ? "it has a touch screen" : "it has no touch screen";
    if (this.file.keyboard !== "auto") return "you said so in Settings › This device";
    if (this.found) return "a key was pressed that a touch screen's keyboard doesn't send";
    if (this.file.seen.keyboard) return "a keyboard was used here before";
    if (this.looksLikeDesktop()) return this.preset ? lever : "it has a mouse or trackpad that hovers, as a desktop does";
    return this.preset ? lever : "no key has been pressed yet";
  }

  /** Your override for an extension here, if any. */
  override(id: string): Override | undefined {
    return this.file.extensions[id];
  }

  async setOverride(id: string, value: Override | undefined): Promise<void> {
    this.pending.extensions.set(id, value ?? null);
    this.file = this.merged(this.file);
    for (const fn of this.listeners) fn(this, this.facts);
    await this.save();
  }

  async setKeyboard(choice: KeyboardChoice): Promise<void> {
    this.pending.keyboard = choice;
    this.file = this.merged(this.file);
    this.refresh();
    await this.save();
  }

  /**
   * Read this device's file, take what it says, and write it only if there's something new to say: it
   * isn't there yet, a keyboard or a wider screen was seen, or it wasn't written today. The width the
   * window is now isn't news: two tabs at different widths would write it in turns.
   */
  async load(io: DeviceIo): Promise<void> {
    this.io = io;
    if (!this.path) return;
    const saved = await io.read(this.path).catch(() => null);
    if (!saved) return;
    this.revision = saved.revision;
    const kept = parseDeviceFile(saved.text);
    this.file = this.merged(kept);
    const before = kept.seen;
    const stale = !before || before.keyboard !== this.file.seen.keyboard || before.width !== this.file.seen.width || before.pointer !== this.file.seen.pointer || before.touch !== this.file.seen.touch || kept.lastSeen?.slice(0, 10) !== minute(new Date()).slice(0, 10);
    this.refresh(true);
    if (stale) await this.save();
  }

  /** The file changed elsewhere (another tab wrote it, or you edited it): take what it says, with this tab's own changes on top. */
  async absorb(): Promise<void> {
    if (!this.io || !this.path) return;
    const saved = await this.io.read(this.path).catch(() => null);
    if (!saved || saved.revision <= this.revision) return;
    this.revision = saved.revision;
    this.file = this.merged(parseDeviceFile(saved.text));
    this.refresh();
    for (const fn of this.listeners) fn(this, this.facts);
  }

  /**
   * A file as it is elsewhere, with this tab's part in it: what this browser saw (the widest screen, a
   * keyboard once one was found) and the changes it hasn't written yet. The rest is the file's.
   */
  private merged(there: Partial<DeviceFile>): DeviceFile {
    const extensions = { ...(there.extensions ?? {}) };
    for (const [id, value] of this.pending.extensions) {
      if (value) extensions[id] = value;
      else delete extensions[id];
    }
    const mine = this.file.seen;
    const widest = there.seen && atLeast(there.seen.width, mine.width) ? there.seen.width : mine.width;
    return {
      name: there.name ?? this.file.name,
      lastSeen: this.file.lastSeen,
      seen: { width: widest, pointer: mine.pointer, touch: mine.touch, keyboard: mine.keyboard || !!there.seen?.keyboard || !!this.pending.seenKeyboard },
      keyboard: this.pending.keyboard ?? there.keyboard ?? "auto",
      extensions,
    };
  }

  /**
   * Write the file as this browser has it, one write at a time. One that can't be sent (offline) isn't
   * held: what you chose applies here for now, and goes with the next write.
   */
  private save(): Promise<void> {
    this.writing = this.writing.then(() => this.send()).catch(() => {});
    return this.writing;
  }

  /** Put this tab's changes on the file as it is now, and write that; if it changed meanwhile, again. */
  private async send(): Promise<void> {
    const io = this.io;
    if (!io || !this.path) return;
    this.file.lastSeen = minute(new Date());
    const sending = { keyboard: this.pending.keyboard, extensions: new Map(this.pending.extensions) };
    for (let tries = 0; tries < 3; tries++) {
      const saved = await io.read(this.path);
      const file = this.merged(parseDeviceFile(saved.text));
      const result = await io.write(this.path, deviceText(file), saved.revision);
      if (result.status === "conflict") continue;
      this.revision = result.file.revision;
      this.file = file;
      // Written: what was sent is the file's now, unless it was changed again while it went.
      if (this.pending.keyboard === sending.keyboard) delete this.pending.keyboard;
      for (const [id, value] of sending.extensions) if (this.pending.extensions.get(id) === value) this.pending.extensions.delete(id);
      delete this.pending.seenKeyboard;
      return;
    }
  }

  /** As the inspector and Settings › This device show it. */
  describe() {
    return {
      id: this.id,
      path: this.path,
      preset: this.preset,
      facts: this.facts,
      why: { keyboard: this.why("keyboard"), width: this.why("width"), pointer: this.why("pointer"), touch: this.why("touch") },
      file: this.file,
    };
  }
}
