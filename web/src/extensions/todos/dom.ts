// Small DOM helpers for the Todos extension's chips, editors and lists: an element with its attributes
// and children, a line icon, and a person's initials in a coloured circle.

type Child = Node | string | null | undefined | false;

/**
 * An element: `class`, `style` (an object; custom properties too), `on<event>` handlers, and any other
 * attribute (true for a bare one; null, undefined and false leave it out).
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "style" && typeof v === "object") {
      for (const [p, val] of Object.entries(v as Record<string, string>)) node.style.setProperty(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), val);
    } else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  // An icon-only button's tooltip is its name for screen readers too.
  if (tag === "button" && attrs.title && !attrs["aria-label"] && !node.textContent?.trim()) node.setAttribute("aria-label", String(attrs.title));
  return node;
}

const ICONS: Record<string, string> = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  sliders: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  task: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

const SVG = "http://www.w3.org/2000/svg";
const parsed = new Map<string, SVGSVGElement>();

/** A line icon by name, `size` pixels square, in the text's colour. */
export function icon(name: string, size = 16): SVGSVGElement {
  const key = `${name} ${size}`;
  let svg = parsed.get(key);
  if (!svg) {
    svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
    // The paths are this file's own, fixed strings.
    svg.innerHTML = ICONS[name] ?? "";
    parsed.set(key, svg);
  }
  return svg.cloneNode(true) as SVGSVGElement;
}

/** A hue for a name, the same every time. */
function hueFor(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [258, 285, 205, 330, 190, 20, 240][h % 7];
}

/** A person's initials in a circle of their colour. */
export function avatar(name: string, size = 20): HTMLElement {
  const initials = name.replace(/[^\p{L}\p{N}]/gu, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return el("span", { class: "avatar", title: name, style: { "--hue": String(hueFor(name)), width: `${size}px`, height: `${size}px` } }, initials || "?");
}
