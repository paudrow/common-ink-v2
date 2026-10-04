// The Worker's files API, as the web app calls it.
import type { SourceStatus } from "../../worker/src/data-sources.ts";
import type { Contact, Event } from "../../worker/src/sources.ts";
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
  async sources(): Promise<SourceStatus> {
    return (await ok(await fetch("/api/sources"))).json();
  },
  /** Data source answers: the list, or the reason there isn't one (such as Google not being connected). */
  async events(from: Date, to: Date): Promise<Event[]> {
    return sourceList(await fetch(`/api/events?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`));
  },
  async contacts(query = ""): Promise<Contact[]> {
    return sourceList(await fetch(`/api/contacts?${new URLSearchParams({ query })}`));
  },
};

async function sourceList<T>(res: Response): Promise<T[]> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status}`);
  return body as T[];
}
