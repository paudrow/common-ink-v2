// The Worker's files API, as the web app calls it.
import type { CatalogEntry } from "../../worker/src/catalog.ts";
import type { LinkCard } from "../../worker/src/link-card.ts";
import type { EditResult, SourceState, SourceStatus } from "../../worker/src/data-sources.ts";
import type { Calendar, Occurrence } from "../../worker/src/calendar.ts";
import type { EventFound } from "../../worker/src/operations.ts";
import type { Contact } from "../../worker/src/sources.ts";
import type { WorkspaceFile, FilePath, FileSummary, Revision, WriteResult } from "../../worker/src/files.ts";
import type { Upload } from "../../worker/src/uploads.ts";

/** An upload as the page knows it: what it is, and its address. */
export type UploadDone = Upload & { url: string };

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

/** What an extension's brokered fetch gets back. */
export interface ExtensionResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
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
  /** Upload a file's bytes. Refusals (empty, too big) come back as errors that say why. */
  async upload(name: string, data: Blob): Promise<UploadDone> {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: data });
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
    const result = (await res.json()) as { upload: Upload; url: string };
    return { ...result.upload, url: result.url };
  },
  /** Delete a file as of the revision you read. A change like any other: undo brings it back. */
  async delete(path: FilePath, base: Revision): Promise<WriteResult> {
    const res = await fetch("/api/file", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, base }) });
    return (res.status === 409 ? res : await ok(res)).json();
  },
  /** Write a file for an extension: the change's author is the extension, acting for you. */
  async writeAs(extension: string, path: FilePath, text: string, base: Revision): Promise<WriteResult> {
    const res = await fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json", "X-Common-Ink-Extension": extension }, body: JSON.stringify({ path, text, base }) });
    return (res.status === 409 ? res : await ok(res)).json();
  },
  /** A token for a sandboxed extension's host to load its code with. */
  async sandboxToken(extension: string): Promise<string> {
    return ((await (await ok(await fetch(`/api/sandbox/token?extension=${encodeURIComponent(extension)}`))).json()) as { token: string }).token;
  },
  /** Fetch a URL for an extension, through the Worker, which checks what it declares and what you've allowed. */
  async extensionFetch(extension: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, once: boolean): Promise<ExtensionResponse> {
    const res = await fetch("/api/extensions/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extension, url, method: init.method, headers: init.headers, body: init.body, once }) });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
    return data as ExtensionResponse;
  },
  /** A link's card, for an extension: its title, description and picture, fetched by the Worker like any brokered fetch. */
  async extensionCard(extension: string, url: string, once: boolean): Promise<LinkCard> {
    const res = await fetch("/api/extensions/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extension, url, once, card: true }) });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
    return data as LinkCard;
  },
  /** Another catalog's extensions, its index read through the Worker. */
  async catalog(url: string): Promise<CatalogEntry[]> {
    const res = await fetch(`/api/extensions/catalog?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
    return (data as { entries: CatalogEntry[] }).entries;
  },
  /** Install an extension from where it's published; `catalog` names the catalog that listed it, if one did. */
  async installExtension(url: string, catalog?: string): Promise<{ id: string; name: string; files: string[] }> {
    const res = await fetch("/api/extensions/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, catalog }) });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
    return data as { id: string; name: string; files: string[] };
  },
  async history(path: FilePath): Promise<Array<{ revision: Revision }>> {
    return (await ok(await fetch(`/api/history?${new URLSearchParams({ path, limit: "50" })}`))).json();
  },
  async version(path: FilePath, revision: Revision): Promise<string | null> {
    const res = await fetch(`/api/version?${new URLSearchParams({ path, revision: String(revision) })}`);
    return res.status === 404 ? null : (((await (await ok(res)).json()) as { text?: string } | null)?.text ?? null);
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
  async calendars(): Promise<Calendar[]> {
    return answer(await fetch("/api/calendars"));
  },
  async events(from: Date, to: Date, calendars?: string[]): Promise<Occurrence[]> {
    return answer(await fetch(`/api/events?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), zone: ZONE, ...(calendars ? { calendars: calendars.join(",") } : {}) })}`));
  },
  async event(address: string): Promise<EventFound | null> {
    return answer(await fetch(`/api/event?${new URLSearchParams({ address, zone: ZONE })}`));
  },
  /** Bring the calendar's own changes in, unless it synced just now: how its source stands after. */
  async sync(force = false): Promise<SourceState> {
    return answer(await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) }));
  },
  /** Add, change or delete an event. An extension other than a built-in is named as the change's author, acting for you. */
  async editEvent(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>, extension?: string): Promise<EditResult> {
    const route = method === "POST" ? "/api/events" : "/api/event";
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(extension ? { "X-Common-Ink-Extension": extension } : {}) };
    return answer(await fetch(route, { method, headers, body: JSON.stringify({ ...body, zone: ZONE }) }));
  },
  async contacts(query = ""): Promise<Contact[]> {
    return sourceList(await fetch(`/api/contacts?${new URLSearchParams({ query })}`));
  },
};

/** The person's time zone: how floating times and all-day events are read. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The server answered, with a problem: what it said, and its HTTP status. */
export class ServerAnswer extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function answer<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ServerAnswer((body as { error?: string } | null)?.error ?? `${res.status}`, res.status);
  return body as T;
}

const sourceList = <T>(res: Response) => answer<T[]>(res);
