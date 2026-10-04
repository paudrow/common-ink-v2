// The Worker's notes API, as the web app calls it.
import type { Note, NotePath, NoteSummary, Revision, WriteResult } from "../../worker/src/notes.ts";

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

export const api = {
  async list(): Promise<NoteSummary[]> {
    return (await ok(await fetch("/api/notes"))).json();
  },
  /** The note, or an empty one at revision 0 if there's no note at that path yet. */
  async read(path: NotePath): Promise<Note> {
    const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`);
    return res.status === 404 ? { path, text: "", revision: 0 } : (await ok(res)).json();
  },
  async write(path: NotePath, text: string, base: Revision, keepalive = false): Promise<WriteResult> {
    const body = JSON.stringify({ path, text, base });
    const res = await fetch("/api/note", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive });
    return (res.status === 409 ? res : await ok(res)).json();
  },
};
