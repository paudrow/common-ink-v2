// A webview: a sandboxed frame showing HTML an extension wrote (ADR 0006). The app hands it a
// MessagePort, then the HTML, which replaces this page. The page it writes gets `commonInk`: post() to
// send a message to its extension, and onMessage() to hear from it. Nothing in here can connect out.
// It reports its page's height, for a frame that sizes to its content.
(() => {
  let port = null;
  const listeners = [];
  const size = new ResizeObserver(() => port && port.postMessage({ type: "height", height: Math.ceil(document.documentElement.getBoundingClientRect().height) }));
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
        addEventListener("load", () => port.postMessage({ type: "loaded" }), { once: true });
      } else if (m.type === "message") for (const fn of listeners) fn(m.data);
      else if (m.type === "ping") port.postMessage({ type: "pong", id: m.id });
    };
    port.postMessage({ type: "ready" });
  });
})();
