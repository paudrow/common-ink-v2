// The recorded network, for the `net=replay` test lever (docs/TESTING.md): brokered fetches and link
// cards answer from test/fixtures/net.json and never leave the Worker. `npm run net:record -- <url>`
// adds to it.
import type { SafeFetchOptions } from "./safe-fetch.ts";

/** One recorded answer. A binary body (a picture) is kept as base64. */
export interface Recording {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  base64?: string;
}

/** Recordings by URL for a GET, or by "METHOD URL" for anything else. */
export type Recordings = Record<string, Recording>;

export const recordingKey = (method: string, url: string) => (method.toUpperCase() === "GET" ? url : `${method.toUpperCase()} ${url}`);

/** A fetch that answers from recordings, and a DNS lookup that finds every host public, for safeFetch. */
export function replay(recordings: Recordings): Required<Pick<SafeFetchOptions, "fetcher" | "resolve">> {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const recorded = recordings[recordingKey(init?.method ?? "GET", url)];
    if (!recorded) throw new TypeError(`no recording of it (the network is replayed; npm run net:record -- ${url} adds one)`);
    const body = recorded.base64 ? Uint8Array.from(atob(recorded.base64), (c) => c.charCodeAt(0)) : (recorded.body ?? "");
    return new Response(body, { status: recorded.status, headers: recorded.headers });
  };
  return { fetcher: fetcher as typeof fetch, resolve: async () => ["93.184.215.14"] };
}
