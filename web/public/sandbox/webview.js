// A webview: a sandboxed frame showing HTML an extension wrote (ADR 0006). The app hands it a
// MessagePort, then the HTML, which replaces this page. The page it writes gets `commonInk`: post() to
// send a message to its extension, and onMessage() to hear from it. Nothing in here can connect out.
// It reports its page's height, for a frame that sizes to its content, and says when its page has
// first painted something (text, a canvas, a picture), so the app shows the frame only then and never a
// blank one. With test levers on (?probe), it
// also says when its page first draws on a canvas, keeps WebGL's drawing so it can be read back, and
// answers a probe with what its canvases show.
(() => {
  let port = null;
  const listeners = [];
  const probing = new URLSearchParams(location.search).has("probe");
  const drawn = { webgl: 0, "2d": 0 };
  let frames = 0;
  let sampling = false;
  const kinds = new WeakMap();
  if (probing) {
    const raf = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (fn) => raf((t) => (frames++, fn(t)));
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, options) {
      const webgl = /webgl/.test(kind);
      const ctx = getContext.call(this, kind, webgl ? { ...options, preserveDrawingBuffer: true } : options);
      if (ctx) kinds.set(this, webgl ? "webgl" : kind);
      return ctx;
    };
    const count = (proto, names, kind) => {
      for (const name of names) {
        const draw = proto && proto[name];
        if (!draw) continue;
        proto[name] = function (...args) {
          if (!sampling && drawn[kind]++ === 0 && port) port.postMessage({ type: "drawn", drawn: { ...drawn } });
          return draw.apply(this, args);
        };
      }
    };
    count(self.WebGLRenderingContext && WebGLRenderingContext.prototype, ["drawArrays", "drawElements"], "webgl");
    count(self.WebGL2RenderingContext && WebGL2RenderingContext.prototype, ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"], "webgl");
    count(CanvasRenderingContext2D.prototype, ["fill", "stroke", "fillRect", "strokeRect", "fillText", "strokeText", "drawImage", "putImageData"], "2d");
  }
  /** A canvas at 16 × 16: how much of it is drawn on, and in how many colors. */
  const sample = (canvas) => {
    const out = { kind: kinds.get(canvas) || "none", width: canvas.width, height: canvas.height, filled: 0, colors: 0 };
    if (!canvas.width || !canvas.height) return out;
    const small = document.createElement("canvas");
    small.width = small.height = 16;
    const g = small.getContext("2d");
    sampling = true;
    try {
      g.drawImage(canvas, 0, 0, 16, 16);
    } finally {
      sampling = false;
    }
    const data = g.getImageData(0, 0, 16, 16).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]) out.filled++;
      colors.add(data.slice(i, i + 4).join());
    }
    out.filled /= 256;
    out.colors = colors.size;
    return out;
  };
  const size = new ResizeObserver(() => port && port.postMessage({ type: "height", height: Math.ceil(document.documentElement.getBoundingClientRect().height) }));
  /**
   * Say "painted" once the page shows something: at load if it already has text or a canvas, picture or
   * video, or else as soon as some appears (a board drawn from its extension's first message). Two
   * animation frames later, so it's on screen. After 3 s regardless, so a page that stays empty shows.
   */
  const watchFirstPaint = () => {
    let done = false;
    const shows = () => !!document.body && (document.body.innerText.trim() !== "" || !!document.querySelector("canvas, img, svg, video"));
    const paint = () => {
      if (done) return;
      done = true;
      watch.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => port.postMessage({ type: "painted" })));
    };
    const watch = new MutationObserver(() => shows() && paint());
    if (shows()) return paint();
    watch.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(paint, 3000);
  };
  window.commonInk = {
    post: (message) => port && port.postMessage({ type: "message", data: message }),
    onMessage: (fn) => void listeners.push(fn),
  };
  addEventListener("message", (e) => {
    if (e.source !== parent || port || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "html") {
        listeners.length = 0;
        document.open();
        document.write(m.html);
        document.close();
        size.disconnect();
        size.observe(document.documentElement);
        // Its scripts (modules included) have run once the page loads: it's drawn, or about to be.
        addEventListener("load", () => (port.postMessage({ type: "loaded" }), watchFirstPaint()), { once: true });
      } else if (m.type === "message") for (const fn of listeners) fn(m.data);
      else if (m.type === "ping") port.postMessage({ type: "pong", id: m.id });
      else if (m.type === "probe" && probing) port.postMessage({ type: "probe", id: m.id, frames, drawn: { ...drawn }, canvases: [...document.querySelectorAll("canvas")].map(sample) });
    };
    port.postMessage({ type: "ready" });
  });
})();
