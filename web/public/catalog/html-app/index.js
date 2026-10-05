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
    ctx.embeds.register("html-app", {
      resolve(webview, embed) {
        webview.html = HEAD + embed.body;
      },
    });
  },
};
