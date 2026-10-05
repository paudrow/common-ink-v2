// Record what the Worker's safe fetch gets from a URL, for the `net=replay` lever (docs/TESTING.md):
// brokered fetches and link cards then answer from test/fixtures/net.json, the same every time.
//
//   npm run net:record -- <url> [--card]
//
// --card records what a link card needs: the page, and its picture. A page is kept to its <head>, which
// is all a card reads, and a picture over 64 kB becomes a small grey stand-in, so recordings stay small.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { linkCard } from "../worker/src/link-card.ts";
import { recordingKey, type Recording, type Recordings } from "../worker/src/net-replay.ts";
import { safeFetch } from "../worker/src/safe-fetch.ts";

const FILE = path.resolve(import.meta.dirname, "../test/fixtures/net.json");
/** A 1 × 1 grey PNG. */
const STAND_IN = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+PDhfwAJDQOz3VYKHgAAAABJRU5ErkJggg==";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { card: { type: "boolean" } } });
if (!positionals.length) throw new Error("Usage: npm run net:record -- <url> [--card]");

const recorded: Recordings = {};
const recording = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  const url = String(input instanceof Request ? input.url : input);
  // DNS lookups aren't replayed: replay finds every host public.
  if (url.startsWith("https://cloudflare-dns.com/")) return res;
  const type = res.headers.get("content-type") ?? "";
  const headers: Record<string, string> = Object.fromEntries(["content-type", "location"].flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)!]] : [])));
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const kept: Recording = { status: res.status, headers };
  if (/^(text|application\/(xhtml|json|xml))/.test(type) || !bytes.length) kept.body = new TextDecoder().decode(bytes).replace(/<body[\s\S]*$/i, "</html>");
  else kept.base64 = bytes.length > 64_000 ? (((headers["content-type"] = "image/png"), STAND_IN)) : Buffer.from(bytes).toString("base64");
  recorded[recordingKey(init?.method ?? "GET", url)] = kept;
  return res;
};

for (const url of positionals) {
  if (values.card) console.log(JSON.stringify(await linkCard(url, { fetcher: recording as typeof fetch })).slice(0, 200));
  else console.log((await safeFetch(url, { fetcher: recording as typeof fetch })).status, url);
}
const all: Recordings = { ...JSON.parse(fs.readFileSync(FILE, "utf8")), ...recorded };
fs.writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
console.log(`Recorded ${Object.keys(recorded).length} answers in test/fixtures/net.json`);
