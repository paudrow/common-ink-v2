// The Worker's docs API, as the web app calls it.
import type { Doc, DocPath, DocSummary, Revision, WriteResult } from "../../worker/src/docs.ts";

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

export const api = {
  async list(): Promise<DocSummary[]> {
    return (await ok(await fetch("/api/docs"))).json();
  },
  /** The doc, or an empty one at revision 0 if there's nothing at that path yet. */
  async read(path: DocPath): Promise<Doc> {
    const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
    return res.status === 404 ? { path, text: "", revision: 0 } : (await ok(res)).json();
  },
  async write(path: DocPath, text: string, base: Revision, keepalive = false): Promise<WriteResult> {
    const body = JSON.stringify({ path, text, base });
    const res = await fetch("/api/doc", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive });
    return (res.status === 409 ? res : await ok(res)).json();
  },
};
