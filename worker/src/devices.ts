// Devices: what the browser Common Ink is open in has (a width, a pointer, touch, a keyboard), what
// extensions and their contributions need from it ("requires" in a manifest), and the device's file,
// .common-ink/users/<you>/devices/<id>/device.json, which keeps what was seen there and your
// overrides. Pure, so the app, tests and agents read devices the same way.
import { parseFilePath, type FilePath } from "./files.ts";

/** How wide the window is, in Material's classes: under 600px, 600, 840 and 1200 and up. */
export type WidthClass = "compact" | "medium" | "expanded" | "large";

export const WIDTH_CLASSES: readonly WidthClass[] = ["compact", "medium", "expanded", "large"];

/** The narrowest width, in CSS pixels, of each class. */
export const WIDTH_MIN: Readonly<Record<WidthClass, number>> = { compact: 0, medium: 600, expanded: 840, large: 1200 };

export const widthClassOf = (px: number): WidthClass => [...WIDTH_CLASSES].reverse().find((c) => px >= WIDTH_MIN[c])!;

/** Whether a width class is at least as wide as another. */
export const atLeast = (have: WidthClass, min: WidthClass) => WIDTH_CLASSES.indexOf(have) >= WIDTH_CLASSES.indexOf(min);

/** What an extension, or one of its contributions, needs from a device: each one named must hold. */
export interface Requires {
  keyboard?: true;
  /** At least this wide. */
  width?: WidthClass;
  /** A mouse or trackpad. */
  pointer?: "fine";
}

/** What a device has, now. */
export interface Facts {
  width: WidthClass;
  /** The window's width in CSS pixels. */
  px: number;
  pointer: "fine" | "coarse";
  touch: boolean;
  keyboard: boolean;
}

/** One requirement a device doesn't meet. */
export type Need = { kind: "keyboard" } | { kind: "pointer" } | { kind: "width"; min: WidthClass };

/** The requirements `facts` doesn't meet, in the order they're said. */
export function unmet(requires: Requires | undefined, facts: Facts): Need[] {
  if (!requires) return [];
  const out: Need[] = [];
  if (requires.keyboard && !facts.keyboard) out.push({ kind: "keyboard" });
  if (requires.width && !atLeast(facts.width, requires.width)) out.push({ kind: "width", min: requires.width });
  if (requires.pointer && facts.pointer !== "fine") out.push({ kind: "pointer" });
  return out;
}

/** "needs a keyboard and a screen 600px wide". */
export function needsText(needs: readonly Need[]): string {
  const words = needs.map((n) => (n.kind === "keyboard" ? "a keyboard" : n.kind === "pointer" ? "a mouse or trackpad" : `a screen ${WIDTH_MIN[n.min]}px wide`));
  return `needs ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}`;
}

/** What you said about an extension on one device: on here, whatever it needs; or off here. No override is Auto. */
export type Override = "on" | "off";

/** Whether something is on, on this device, and why. Turning it off everywhere (extensions.disabled) comes before this. */
export type Here = { on: true; by: "default" } | { on: true; by: "you"; needs: Need[] } | { on: false; by: "you" } | { on: false; by: "needs"; needs: Need[] };

/** Whether something that needs `requires` is on here: your override for this device first, then what it needs. */
export function here(requires: Requires | undefined, facts: Facts, override?: Override): Here {
  const needs = unmet(requires, facts);
  if (override === "off") return { on: false, by: "you" };
  if (override === "on") return { on: true, by: "you", needs };
  return needs.length ? { on: false, by: "needs", needs } : { on: true, by: "default" };
}

/** A Here in words, as the Extensions view says it: "Off on this device · needs a keyboard". Null when it's simply on. */
export function hereText(h: Here): string | null {
  if (h.by === "default") return null;
  if (h.by === "needs") return `Off on this device · ${needsText(h.needs)}`;
  if (!h.on) return "Off on this device · you turned it off here";
  return h.needs.length ? `On here · you turned it on; it ${needsText(h.needs)}` : "On here · you turned it on";
}

/** Whether this device has a keyboard: Auto (the app works it out), or what you said. */
export type KeyboardChoice = "auto" | "yes" | "no";

/** A device's file: what was seen on it, and your choices for it. */
export interface DeviceFile {
  /** What the device is, as it was first seen: "iPhone · Safari". */
  name: string;
  /** When the app was last opened on it, to the minute. */
  lastSeen: string;
  /** What it had when it was last opened, and a keyboard once one is found. */
  seen: { width: WidthClass; pointer: "fine" | "coarse"; touch: boolean; keyboard: boolean };
  keyboard: KeyboardChoice;
  /** Extensions you turned on or off here, by id. */
  extensions: Record<string, Override>;
}

/** The folder a person's devices are kept in. */
export const devicesDir = (email: string) => `.common-ink/users/${email}/devices/`;

/** A device's id: what the browser keeps, and its folder's name. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const devicePath = (email: string, id: string): FilePath | null => (DEVICE_ID.test(id) ? parseFilePath(`${devicesDir(email)}${id}/device.json`) : null);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A device file's contents, as far as they make sense: anything missing or wrong is left out, so it's worked out afresh. */
export function parseDeviceFile(text: string): Partial<DeviceFile> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isObject(data)) return {};
  const out: Partial<DeviceFile> = {};
  if (typeof data.name === "string") out.name = data.name;
  if (typeof data.lastSeen === "string") out.lastSeen = data.lastSeen;
  if (isObject(data.seen)) {
    const s = data.seen;
    out.seen = {
      width: WIDTH_CLASSES.includes(s.width as WidthClass) ? (s.width as WidthClass) : "compact",
      pointer: s.pointer === "fine" ? "fine" : "coarse",
      touch: s.touch === true,
      keyboard: s.keyboard === true,
    };
  }
  if (data.keyboard === "auto" || data.keyboard === "yes" || data.keyboard === "no") out.keyboard = data.keyboard;
  if (isObject(data.extensions)) out.extensions = Object.fromEntries(Object.entries(data.extensions).filter((e): e is [string, Override] => e[1] === "on" || e[1] === "off"));
  return out;
}

/** A device file's text, as the app writes it. */
export const deviceText = (file: DeviceFile) => `${JSON.stringify(file, null, 2)}\n`;

/** A browser's name for its device file, from its user agent: "iPhone · Safari", "Mac · Chrome". */
export function deviceName(userAgent: string): string {
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? /Mobile/.test(userAgent)
          ? "Android phone"
          : "Android tablet"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /CrOS/.test(userAgent)
              ? "Chromebook"
              : /Linux/.test(userAgent)
                ? "Linux"
                : "A browser";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}
