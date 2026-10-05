import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
});

const { EditorView } = await import("@codemirror/view");
const { uploadInto, uploadMarkdown } = await import("../web/src/extensions/uploads/index.ts");

test("an image upload is an image in markdown; anything else is a link", () => {
  assert.equal(uploadMarkdown({ name: "Garden plan.png", type: "image/png" }), "![Garden plan](/uploads/Garden%20plan.png)");
  assert.equal(uploadMarkdown({ name: "lease.pdf", type: "application/pdf" }), "[lease.pdf](/uploads/lease.pdf)");
});

test("dropped files show as uploading where they go, then become links; one that fails is taken out and said why", async () => {
  const view = new EditorView({ doc: "# Trip\nPhotos:", parent: document.body });
  const notices: string[] = [];
  let finish: () => void = () => {};
  const ctx = {
    files: {
      upload: async (name: string) => {
        if (name === "huge.mov") throw new Error("huge.mov is over 25 MB");
        await new Promise<void>((r) => (finish = r));
        return { name, hash: "", size: 1, type: "image/jpeg", url: `/uploads/${name}` };
      },
    },
    workbench: { notice: (m: string) => notices.push(m) },
  } as never;
  const file = (name: string) => new window.File(["x"], name) as unknown as File;
  const done = uploadInto(ctx, view, view.state.doc.length, [file("beach.jpg"), file("huge.mov")]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(view.state.doc.toString(), "# Trip\nPhotos:\n![Uploading beach.jpg… 1]()\n");
  assert.deepEqual(notices, ["huge.mov wasn't uploaded: huge.mov is over 25 MB"], "the failed one is out already");
  // Typing while it uploads is fine.
  view.dispatch({ changes: { from: 0, insert: "Hello\n" } });
  finish();
  await done;
  assert.equal(view.state.doc.toString(), "Hello\n# Trip\nPhotos:\n![beach](/uploads/beach.jpg)\n");
  view.destroy();
});
