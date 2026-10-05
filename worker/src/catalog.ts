// Catalogs of extensions you can install (ADR 0006). The app serves its own, of first-party extensions
// that aren't on by default, at /catalog/index.json. Other catalogs (the "extensions.catalogs" setting)
// are other people's: their index comes through the Worker's safe fetch, and what they list is installed
// like any extension from a URL, sandboxed, at your own risk.
//
// An index is JSON: {"name": "…", "extensions": [{"id", "name", "version", "description", "path", "embeds"}]},
// where `path` is the extension's folder, relative to the index, and `embeds` the embed languages it
// draws, so a note can say what it needs.

/** The app's own catalog. */
export const FIRST_PARTY_CATALOG = "/catalog/index.json";

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Its folder, where its extension.json is, as an absolute URL. */
  folder: string;
  /** The catalog it's from. */
  catalog: string;
  firstParty: boolean;
  /** The embed languages it draws. */
  embeds: string[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** A catalog's entries, from its index at `indexUrl` (absolute). Entries that aren't complete are left out. */
export function parseCatalog(data: unknown, indexUrl: string, firstParty: boolean): CatalogEntry[] {
  const index = (data && typeof data === "object" ? data : {}) as { name?: unknown; extensions?: unknown };
  const catalog = typeof index.name === "string" && index.name ? index.name : indexUrl;
  if (!Array.isArray(index.extensions)) return [];
  return index.extensions.flatMap((e: Record<string, unknown>) => {
    if (!e || typeof e !== "object") return [];
    const { id, name, version, description, path, embeds } = e;
    if (typeof id !== "string" || !ID.test(id) || typeof name !== "string" || typeof path !== "string") return [];
    const base = new URL(indexUrl);
    const at = new URL(path.endsWith("/") ? path : `${path}/`, base);
    // The app's own catalog lists folders on the app; another catalog may list folders anywhere on the web.
    if (firstParty && at.origin !== base.origin) return [];
    if (!firstParty && at.protocol !== "https:" && at.protocol !== "http:") return [];
    return [
      {
        id,
        name,
        version: typeof version === "string" ? version : "",
        description: typeof description === "string" ? description : "",
        folder: at.toString(),
        catalog,
        firstParty,
        embeds: Array.isArray(embeds) ? embeds.filter((x): x is string => typeof x === "string") : [],
      },
    ];
  });
}
