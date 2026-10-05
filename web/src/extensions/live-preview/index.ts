// Live preview: notes' markdown drawn as it reads (markdown.ts), on the app's live-preview mechanism.
import type { ExtensionContext } from "../../extension-api.ts";
import { markdownPreview } from "./markdown.ts";

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.extend(markdownPreview);
  },
};
