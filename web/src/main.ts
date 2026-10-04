import type { Identity } from "../../worker/src/auth.ts";
import type { NoteSummary } from "../../worker/src/notes.ts";

const status = document.querySelector<HTMLParagraphElement>("#status")!;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

try {
  const [me, notes] = await Promise.all([get<Identity>("/api/me"), get<NoteSummary[]>("/api/notes")]);
  status.textContent = `Running. Signed in as ${me.email}. ${notes.length} ${notes.length === 1 ? "note" : "notes"} in this workspace.`;
} catch (err) {
  status.textContent = `Not running: ${(err as Error).message}`;
}
