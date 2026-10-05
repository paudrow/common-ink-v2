// HTML app, from the app's catalog: an ```html-app block's HTML, run in a webview (a sandboxed frame
// that can't connect anywhere). The libraries it may import by name are served from the sandbox route,
// through an import map ahead of its HTML.
const IMPORTS = {
  three: "/sandbox/vendor/three/three.module.js",
  "three/addons/": "/sandbox/vendor/three/addons/",
  uplot: "/sandbox/vendor/uplot/uPlot.esm.js",
};

const HEAD = `<script type="importmap">${JSON.stringify({ imports: IMPORTS })}</script><link rel="stylesheet" href="/sandbox/vendor/uplot/uPlot.min.css">`;

export default {
  activate(ctx) {
    /** The HTML each frame runs now. */
    const running = new WeakMap();
    ctx.embeds.register("html-app", {
      resolve(webview, embed) {
        running.set(webview, embed.body);
        webview.html = HEAD + embed.body;
      },
      // New HTML runs in the same frame, so there's no blank one on the way; a new height or title needs nothing from it.
      update(webview, embed) {
        if (running.get(webview) === embed.body) return;
        running.set(webview, embed.body);
        webview.html = HEAD + embed.body;
      },
    });
  },
};
