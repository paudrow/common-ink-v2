// The web app's build. Besides the app, it writes /lib/<name>.js for each library extensions may
// import (library-names.ts), and the JavaScript a built-in is customized into.
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

export default defineConfig({
  plugins: [libraries(), builtinCopies()],
  resolve: {
    alias: Object.fromEntries(Object.entries(APP_MODULES).map(([name, { file }]) => [name, `${root}${file}`])),
  },
});
