// A file as it was at one revision, in a read-only tab: its text, or what has changed since, with a way
// to put the file back that way. The view's id says which: version:<revision>:<path>.
import { parseFilePath } from "common-ink/files";
import type { FilePath, Revision } from "../../../../worker/src/files.ts";
import type { Label } from "../../../../worker/src/labels.ts";
import { runLines } from "common-ink/describe";
import type { View } from "../../workbench.ts";

export const VERSION_PREFIX = "version:";

export const versionViewId = (path: FilePath, revision: Revision) => `${VERSION_PREFIX}${revision}:${path}`;

export function parseVersionId(id: string): { path: FilePath; revision: Revision } | null {
  const m = /^version:(\d+):(.+)$/.exec(id);
  const path = m && parseFilePath(m[2]);
  return path ? { path, revision: Number(m![1]) } : null;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

export function versionView(id: string, restored: (path: FilePath) => void): View | null {
  const at = parseVersionId(id);
  if (!at) return null;
  const { path, revision } = at;
  const name = path.replace(/\.md$/, "");
  let showChanges = false;
  const view: View = {
    id,
    title: `${name} @ #${revision}`,
    async render(root) {
      const [version, current, labels] = await Promise.all([
        fetch(`/api/version?${new URLSearchParams({ path, revision: String(revision) })}`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => (r.ok ? r.json() : { text: "" })),
        fetch(`/api/labels?path=${encodeURIComponent(path)}`).then((r) => (r.ok ? r.json() : [])),
      ]);
      if (!version) return root.replaceChildren(el("p", { className: "message", textContent: `${path} never had revision #${revision}.` }));
      const label = (labels as Label[]).find((l) => l.revision === revision)?.name;
      const toggle = el("button", {
        textContent: showChanges ? "Show this version" : "Changes since",
        title: showChanges ? "Show the text as it was" : "Show what has changed between this version and now",
        onclick: () => {
          showChanges = !showChanges;
          void view.render(root);
        },
      });
      const restore = el("button", {
        textContent: "Restore this version",
        title: "Put the note back this way, as a new change you can undo",
        onclick: async () => {
          const res = await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, revision }) });
          restore.textContent = res.ok ? "Restored" : "Couldn't restore";
          if (res.ok) restored(path);
        },
      });
      const lines = runLines(version.text, current.text);
      const body = showChanges
        ? lines.length
          ? el("pre", { className: "diff" }, ...lines.map((l) => el("span", { className: l.kind === "+" ? "add" : "del", textContent: `${l.kind} ${l.text}\n` })))
          : el("p", { className: "empty", textContent: "Nothing has changed since." })
        : el("pre", { className: "version-text", textContent: version.text });
      root.replaceChildren(
        el(
          "div",
          { className: "version-bar" },
          el("span", { textContent: `${name} as it was at ${label ? `“${label}” (#${revision})` : `#${revision}`} · read-only` }),
          toggle,
          restore,
        ),
        body,
      );
    },
  };
  return view;
}
