// The web app's build. Besides the app, it writes /lib/<name>.js for each library extensions may
// import (library-names.ts), the JavaScript a built-in is customized into, KaTeX's styles and fonts, and
// the libraries webviews may load from the sandbox route (three.js, uPlot).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { APP_MODULES, libraryUrl, PACKAGES } from "./src/library-names.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A module that hands over the app's instance of a library, with its exports by name. */
function shim(name: string, exports: readonly string[]): string {
  const named = exports.filter((e) => e !== "default" && /^[A-Za-z_$][\w$]*$/.test(e));
  return `// ${name}, as the app has it: extensions share the app's one copy.\nconst m = await globalThis.__commonInkLibrary(${JSON.stringify(name)});\nexport const { ${named.join(", ")} } = m;\nexport default m.default;\n`;
}

function libraries(): Plugin {
  return {
    name: "common-ink-libraries",
    async generateBundle() {
      for (const name of PACKAGES) {
        const exports = Object.keys(await import(name));
        this.emitFile({ type: "asset", fileName: libraryUrl(name).slice(1), source: shim(name, exports) });
      }
      for (const [name, { exports }] of Object.entries(APP_MODULES)) this.emitFile({ type: "asset", fileName: libraryUrl(name).slice(1), source: shim(name, exports) });
    },
  };
}

/**
 * The built-ins as JavaScript, for Customize to copy: TypeScript files with their types stripped and
 * `.ts` imports pointed at `.js`, and extension.json saying so. Served as virtual:builtin-copies.
 */
function builtinCopies(): Plugin {
  const id = "virtual:builtin-copies";
  return {
    name: "common-ink-builtin-copies",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    async load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const { transform } = await import("rolldown/experimental");
      const dir = `${root}web/src/extensions/`;
      const copies: Record<string, Record<string, string>> = {};
      for (const ext of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const files: Record<string, string> = {};
        for (const file of readdirSync(`${dir}${ext.name}`)) {
          const text = readFileSync(`${dir}${ext.name}/${file}`, "utf8");
          const js = (t: string) => t.replace(/(from\s+["']|import\s*\(\s*["'])(\.\.?\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
          if (file.endsWith(".ts")) files[file.replace(/\.ts$/, ".js")] = js((await transform(file, text, { lang: "ts" })).code);
          else if (file === "extension.json") files[file] = text.replace(/"([\w./-]+)\.ts"/g, '"$1.js"');
          else files[file] = text;
        }
        copies[ext.name] = files;
      }
      return `export default ${JSON.stringify(copies)};`;
    },
  };
}

/**
 * KaTeX's stylesheet and fonts, at /assets/katex-<version>/, for the LaTeX extension to link once KaTeX
 * loads. Under /assets, the service worker keeps them for offline; the version keeps that safe. Only the
 * woff2 fonts: browsers that read the stylesheet take those first.
 */
function katexAssets(): Plugin {
  return {
    name: "common-ink-katex-assets",
    generateBundle() {
      const dist = `${root}node_modules/katex/dist/`;
      const { version } = JSON.parse(readFileSync(`${root}node_modules/katex/package.json`, "utf8"));
      const at = `assets/katex-${version}/`;
      this.emitFile({ type: "asset", fileName: `${at}katex.min.css`, source: readFileSync(`${dist}katex.min.css`) });
      for (const font of readdirSync(`${dist}fonts`).filter((f) => f.endsWith(".woff2"))) this.emitFile({ type: "asset", fileName: `${at}fonts/${font}`, source: readFileSync(`${dist}fonts/${font}`) });
    },
  };
}

/**
 * Libraries a webview may load, served from the sandbox route (its policy allows scripts and styles from
 * there and nowhere else): /sandbox/vendor/<name>/…. An html-app's page imports them by name through an
 * import map (see docs/embeds.md). Scripts are minified, with their licence kept on top.
 */
const VENDOR: Array<{ to: string; from: string; banner?: string }> = [
  { to: "three/three.module.js", from: "three/build/three.module.js", banner: "three.js, MIT License, Copyright 2010-2026 Three.js Authors" },
  { to: "three/three.core.js", from: "three/build/three.core.js", banner: "three.js, MIT License, Copyright 2010-2026 Three.js Authors" },
  { to: "three/addons/controls/OrbitControls.js", from: "three/examples/jsm/controls/OrbitControls.js", banner: "three.js, MIT License, Copyright 2010-2026 Three.js Authors" },
  { to: "uplot/uPlot.esm.js", from: "uplot/dist/uPlot.esm.js", banner: "uPlot, MIT License, Copyright (c) 2022 Leon Sorokin" },
  { to: "uplot/uPlot.min.css", from: "uplot/dist/uPlot.min.css" },
];

function sandboxVendor(): Plugin {
  return {
    name: "common-ink-sandbox-vendor",
    async generateBundle() {
      const { minify } = await import("rolldown/experimental");
      for (const v of VENDOR) {
        const source = readFileSync(`${root}node_modules/${v.from}`, "utf8");
        const code = v.to.endsWith(".js") ? `/* ${v.banner} */\n${(await minify(v.to, source, { module: true })).code}` : source;
        this.emitFile({ type: "asset", fileName: `sandbox/vendor/${v.to}`, source: code });
      }
    },
  };
}

/** language-data's Markdown entry gets the notes' own markdown language: see web/src/code-markdown.ts. */
function markdownInCodeBlocks(): Plugin {
  return {
    name: "common-ink-markdown-in-code-blocks",
    enforce: "pre",
    resolveId: (source, importer) => (source === "@codemirror/lang-markdown" && importer?.includes("/@codemirror/language-data/") ? `${root}web/src/code-markdown.ts` : null),
  };
}

export default defineConfig({
  plugins: [libraries(), builtinCopies(), katexAssets(), markdownInCodeBlocks(), sandboxVendor()],
  resolve: {
    alias: Object.fromEntries(Object.entries(APP_MODULES).map(([name, { file }]) => [name, `${root}${file}`])),
  },
});
