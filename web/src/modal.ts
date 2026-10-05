// A modal dialog over the app, for everything that asks or shows something on top: an extension's
// details, a permission prompt, confirming. Keyboard-first: focus starts inside, Tab stays inside,
// Escape backs out, and focus goes back where it came from. Modals stack; the top one has the keys.

export interface Modal {
  /** The dialog itself: its content goes here, and can be drawn again any time. */
  readonly box: HTMLElement;
  close(): void;
}

export interface ModalOptions {
  /** What a screen reader calls it. */
  label: string;
  className?: string;
  /** "alertdialog" for one that needs an answer. */
  role?: "dialog" | "alertdialog";
  /** What Escape does; closing, unless it says otherwise. */
  onEscape?: () => void;
  /** Whether a click on the page around it closes it. */
  closeOnOutside?: boolean;
  /** Where focus goes when it closes; asked then, since what opened it may have been drawn again. */
  returnTo?: () => HTMLElement | null;
  onClose?: () => void;
}

const open: Modal[] = [];

/** Whether a modal is showing, so the app's own shortcuts wait. */
export const modalOpen = () => open.length > 0;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** Whether an element shows: not hidden, and not inside a closed <details> (its summary shows). */
function shows(e: HTMLElement): boolean {
  if (e.closest("[hidden]")) return false;
  const closed = e.closest("details:not([open])");
  return !closed || (e.tagName === "SUMMARY" && e.parentElement === closed);
}

/** What Tab moves between inside a box, in order: what's enabled and shown. */
const stops = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shows);

export function openModal(o: ModalOptions): Modal {
  const opener = document.activeElement as HTMLElement | null;
  const box = document.createElement("div");
  box.className = `modal${o.className ? ` ${o.className}` : ""}`;
  box.setAttribute("role", o.role ?? "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", o.label);
  box.tabIndex = -1;
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.append(box);
  let closed = false;
  const modal: Modal = {
    box,
    close() {
      if (closed) return;
      closed = true;
      scrim.remove();
      open.splice(open.indexOf(modal), 1);
      const back = o.returnTo?.() ?? opener;
      if (back?.isConnected) back.focus();
      o.onClose?.();
    },
  };
  box.addEventListener("keydown", (e) => {
    if (open.at(-1) !== modal) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (o.onEscape) o.onEscape();
      else modal.close();
    }
    if (e.key === "Tab") {
      const all = stops(box);
      if (!all.length) return e.preventDefault();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const to = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at === all.length - 1 ? 0 : at + 1;
      e.preventDefault();
      all[to].focus();
    }
  });
  scrim.addEventListener("mousedown", (e) => {
    if (e.target !== scrim) return;
    e.preventDefault();
    if (o.closeOnOutside) modal.close();
    else box.focus();
  });
  open.push(modal);
  document.body.append(scrim);
  box.focus();
  return modal;
}

/** Put focus on the first thing in a modal that takes it, or on the modal itself. */
export function focusFirst(modal: Modal, selector = FOCUSABLE): void {
  (modal.box.querySelector<HTMLElement>(selector) ?? modal.box).focus();
}
