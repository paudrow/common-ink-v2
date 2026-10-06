// Small DOM helpers for the Calendar view: an element with its attributes and children, and line icons.
import { ICON_PATHS } from "common-ink/icons";

type Child = Node | string | null | undefined | false;

/** An element: `class`, `style` (an object; custom properties too), `on<event>` handlers, and any other attribute. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v as Record<string, string>)) node.style.setProperty(p, val);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  if (tag === "button" && attrs.title && !attrs["aria-label"] && !node.textContent?.trim()) node.setAttribute("aria-label", String(attrs.title));
  return node;
}

const ICONS: Record<string, string> = {
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 1 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: ICON_PATHS["trash-2"],
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
};

/** A line icon by name, `size` pixels square, in the text's colour. */
export function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  // The paths are this file's own, fixed strings.
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}

/** Whether the person asked for less motion: scrolls jump instead of gliding. */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
