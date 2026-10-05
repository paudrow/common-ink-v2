// A link's card: what its page says about itself (OpenGraph, Twitter card, or its <title>), and its
// picture as a data: URL, so the app's page shows it without loading anything from another site.
// Fetched by the Worker with the shared safe fetch: no cookies, no referrer, public hosts only.
import { safeFetch, type SafeFetchOptions } from "./safe-fetch.ts";

export interface LinkCard {
  url: string;
  title: string;
  description: string;
  site: string;
  /** The page's picture, as a data: URL, if it has one small enough. */
  image: string | null;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** What a page's <head> says about it. */
export function cardFromHtml(html: string, url: string): Omit<LinkCard, "image"> & { imageUrl: string | null } {
  const head = html.slice(0, html.search(/<\/head>/i) >>> 0 || 200_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !meta.has(key)) meta.set(key, decode(content[1] ?? content[2]));
  }
  const title = meta.get("og:title") ?? meta.get("twitter:title") ?? decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const image = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? null;
  let imageUrl: string | null = null;
  try {
    imageUrl = image ? new URL(image, url).toString() : null;
  } catch {
    imageUrl = null;
  }
  return {
    url,
    title: title || new URL(url).hostname,
    description: meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "",
    site: meta.get("og:site_name") ?? new URL(url).hostname.replace(/^www\./, ""),
    imageUrl: imageUrl && /^https?:/.test(imageUrl) ? imageUrl : null,
  };
}

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A link's card, its page and picture fetched safely. */
export async function linkCard(url: string, options: Pick<SafeFetchOptions, "fetcher" | "resolve"> = {}): Promise<LinkCard> {
  const page = await safeFetch(url, { ...options, maxBytes: 512_000, headers: { Accept: "text/html,application/xhtml+xml" } });
  const type = page.headers["content-type"] ?? "";
  if (page.status !== 200 || !/html/i.test(type)) return { url, title: new URL(url).hostname, description: "", site: new URL(url).hostname.replace(/^www\./, ""), image: null };
  const { imageUrl, ...card } = cardFromHtml(page.body, page.url || url);
  let image: string | null = null;
  if (imageUrl) {
    try {
      const pic = await safeFetch(imageUrl, { ...options, maxBytes: 400_000, binary: true });
      const picType = pic.headers["content-type"] ?? "";
      if (pic.status === 200 && !pic.truncated && /^image\/(png|jpe?g|gif|webp|avif)/i.test(picType) && pic.bytes) image = `data:${picType.split(";")[0]};base64,${base64(pic.bytes)}`;
    } catch {
      // No picture, then.
    }
  }
  return { ...card, image };
}
