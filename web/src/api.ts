// The Worker's files API, as the web app calls it.
import type { WorkspaceFile, FilePath, FileSummary, Revision, WriteResult } from "../../worker/src/files.ts";

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

export const api = {
  async list(): Promise<FileSummary[]> {
    return (await ok(await fetch("/api/files"))).json();
  },
  /** The file, or an empty one at revision 0 if there's nothing at that path yet. */
  async read(path: FilePath): Promise<WorkspaceFile> {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    return res.status === 404 ? { path, text: "", revision: 0 } : (await ok(res)).json();
  },
  async write(path: FilePath, text: string, base: Revision, keepalive = false): Promise<WriteResult> {
    const body = JSON.stringify({ path, text, base });
    const res = await fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive });
    return (res.status === 409 ? res : await ok(res)).json();
  },
};
