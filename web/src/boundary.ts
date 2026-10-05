// Where something drawn into the page throws (a view, an embed, a link embed), the app says so in its
// place and carries on, rather than leaving a blank where it should be or stopping the windows drawing.

/** Draw into `el`; if drawing throws or rejects, report it and say so in `el`. */
export function drawSafely(el: HTMLElement, what: string, draw: () => unknown, report: (err: unknown) => void = (err) => console.error(`${what}:`, err)): void {
  const fail = (err: unknown) => {
    report(err);
    showDrawError(el, what, err);
  };
  try {
    const out = draw();
    if (out instanceof Promise) out.catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** A line in `el` saying `what` couldn't be drawn, and why. What's there already (a webview, say) stays. */
export function showDrawError(el: HTMLElement, what: string, err: unknown): void {
  el.querySelector(":scope > .draw-error")?.remove();
  const line = document.createElement("div");
  line.className = "draw-error";
  line.setAttribute("role", "alert");
  line.style.cssText = "color: #c2410c; font: 0.85em var(--prose); padding: 0.4em 0;";
  line.textContent = `${what} couldn't be drawn: ${err instanceof Error ? err.message : String(err)}`;
  el.append(line);
}
