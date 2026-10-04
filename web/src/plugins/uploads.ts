// Uploads, a built-in plugin: paste or drop files into a note, or run "Upload a file…", and a link to
// each goes where you were: ![photo](/uploads/photo.png) for images, [notes.pdf](/uploads/notes.pdf)
// for anything else. The Uploads view lists them all.
import { EditorView } from "@codemirror/view";
import { isImage, parseUploads, UPLOADS_PATH, uploadUrl, type Upload } from "../../../worker/src/uploads.ts";
import type { PluginContext, PluginModule } from "../plugins.ts";

/** The markdown that links to an upload: an image shows, anything else is a link. */
export function uploadMarkdown(u: Pick<Upload, "name" | "type">, url = uploadUrl(u.name)): string {
  const text = u.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
  return isImage(u.type) ? `![${text}](${url})` : `[${u.name}](${url})`;
}

let pending = 0;

/**
 * Upload files and put their links at `pos`, one per line. Each shows as "Uploading …" where it goes
 * until it's up, so typing meanwhile is fine; one that fails is taken out again and said why.
 */
export async function uploadInto(ctx: Pick<PluginContext, "files" | "workbench">, view: EditorView, pos: number, files: File[]): Promise<void> {
  if (!files.length) return;
  const markers = files.map((f) => `![Uploading ${f.name.replace(/[[\]]/g, "")}… ${++pending}]()`);
  const at = Math.min(pos, view.state.doc.length);
  // On lines of their own: after a line with text on it, a new line first.
  const before = at > 0 && view.state.doc.sliceString(at - 1, at) !== "\n" ? "\n" : "";
  view.dispatch({ changes: { from: at, insert: `${before}${markers.join("\n")}\n` }, userEvent: "input.paste" });
  // Each marker is found again by its text when its upload's done: the note may have changed meanwhile.
  const replace = (marker: string, text: string) => {
    const found = view.state.doc.toString().indexOf(marker);
    if (found >= 0) view.dispatch({ changes: { from: found, to: found + marker.length + (text ? 0 : 1), insert: text } });
  };
  await Promise.all(
    files.map(async (file, i) => {
      try {
        replace(markers[i], uploadMarkdown(await ctx.files.upload(file.name, file)));
      } catch (err) {
        replace(markers[i], "");
        ctx.workbench.notice(`${file.name} wasn't uploaded: ${(err as Error).message}`);
      }
    }),
  );
}

/** Ask for files with the browser's file picker. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const uploadsPlugin: PluginModule = {
  activate(ctx) {
    // Files pasted or dropped into a note upload, and their links go where they landed.
    ctx.editor.extend(
      EditorView.domEventHandlers({
        paste(e, view) {
          const files = [...(e.clipboardData?.files ?? [])];
          if (!files.length || view.state.readOnly) return false;
          e.preventDefault();
          void uploadInto(ctx, view, view.state.selection.main.head, files);
          return true;
        },
        drop(e, view) {
          const files = [...(e.dataTransfer?.files ?? [])];
          if (!files.length || view.state.readOnly) return false;
          e.preventDefault();
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
          void uploadInto(ctx, view, view.state.doc.lineAt(pos).to, files);
          return true;
        },
      }),
    );
    ctx.commands.register(
      {
        id: "uploads.file",
        title: "Upload a file…",
        run: async () => {
          const files = await pickFiles();
          const view = ctx.workbench.focusedView();
          if (view && !view.state.readOnly) return uploadInto(ctx, view, view.state.selection.main.head, files);
          // No note to link from: upload, and show them in the Uploads view.
          for (const f of files) await ctx.files.upload(f.name, f).catch((err) => ctx.workbench.notice(`${f.name} wasn't uploaded: ${(err as Error).message}`));
          ctx.panels.show("uploads");
        },
      },
      { id: "uploads.show", title: "Show uploads", run: () => ctx.panels.toggle("uploads") },
    );
    ctx.panels.register({ id: "uploads", title: "Uploads", render: (root) => renderUploads(ctx, root) });
    ctx.events.onSaved((path) => path === UPLOADS_PATH && ctx.panels.refresh("uploads"));
  },
};

/** Every upload, newest first: a thumbnail for images, its name (which opens it), size, and a way to link it from the note you're in. */
async function renderUploads(ctx: PluginContext, root: HTMLElement) {
  const uploads = parseUploads((await ctx.files.read(UPLOADS_PATH)).text).reverse();
  const add = document.createElement("button");
  add.className = "upload-add";
  add.textContent = "Upload a file…";
  add.addEventListener("click", () => ctx.commands.run("uploads.file"));
  if (!uploads.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing uploaded yet. Paste or drop a file into a note, or:";
    root.replaceChildren(empty, add);
    return;
  }
  const list = document.createElement("ul");
  list.className = "uploads";
  list.append(
    ...uploads.map((u) => {
      const url = uploadUrl(u.name);
      const li = document.createElement("li");
      li.className = "upload";
      if (isImage(u.type)) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        li.append(img);
      }
      const name = document.createElement("a");
      name.href = url;
      name.target = "_blank";
      name.rel = "noopener";
      name.textContent = u.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${size(u.size)} · ${u.type}`;
      const insert = document.createElement("button");
      insert.textContent = "Link here";
      insert.title = "Put a link to it at the cursor in the note you're in";
      insert.addEventListener("click", () => {
        const view = ctx.workbench.focusedView();
        if (!view || view.state.readOnly) return ctx.workbench.notice("Open a note to link it from.");
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: uploadMarkdown(u) }, selection: { anchor: at + uploadMarkdown(u).length } });
      });
      li.append(name, meta, insert);
      return li;
    }),
  );
  root.replaceChildren(add, list);
}
