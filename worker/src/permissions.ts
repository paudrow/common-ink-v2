// Permissions: what an extension's manifest lets it ask for, and what you've answered (ADR 0006).
// Shared by the app, which asks you, and the Worker, which checks again before it fetches for an
// extension. Answers are kept in settings under "extensions.permissions": per extension, per declared
// scope, "allow" or "deny". Built-ins ship with their declared permissions allowed; you can deny any.
import { needsScope, type ExtensionManifest, type PermissionKind } from "./extensions.ts";

export type Answer = "allow" | "deny";

/** What's been answered, as settings keep it: extension id, then "kind" or "kind:scope", then the answer. */
export type Grants = Record<string, Record<string, Answer>>;

/** One thing an extension wants to do: a kind, and for network and files, the host or path. */
export interface Ask {
  kind: PermissionKind;
  /** network: the host. files: the path. settings:write: the key. */
  target?: string;
  /** Or a declared scope itself, such as "Journal/**", for asking about all of it at once. */
  scope?: string;
}

/** A glob over paths: "**" any number of folders, "*" anything within a name, "?" one character. */
export function globMatches(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches no folders or many; a trailing "**" matches everything after.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

/** Whether a declared host covers a host: exactly, "*.example.com" for its subdomains, or "*" for any. */
export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1;
  return h === pattern.toLowerCase();
}

/** The declared scope that covers an ask, or null if the manifest doesn't declare it. Its key is what answers are kept under. */
export function coveringKey(m: ExtensionManifest, ask: Ask): string | null {
  const declared = m.permissions[ask.kind];
  if (!declared) return null;
  if (!needsScope(ask.kind)) return ask.kind;
  const scopes = ask.kind === "network" ? declared.hosts : ask.kind === "settings:write" ? declared.keys : declared.paths;
  if (ask.scope) return scopes?.includes(ask.scope) ? `${ask.kind}:${ask.scope}` : null;
  if (!ask.target) return null;
  const scope = scopes?.find((s) => (ask.kind === "network" ? hostMatches(s, ask.target!) : ask.kind === "settings:write" ? s === ask.target : globMatches(s, ask.target!)));
  return scope ? `${ask.kind}:${scope}` : null;
}

/**
 * Files that decide what runs in the page and what extensions may do: settings (which extensions are
 * trusted, your answers to their asks) and every extension's own files. A sandboxed extension never
 * changes them, whatever it was allowed to write, or it could let itself out.
 */
export const decidesTrust = (path: string) =>
  path === ".common-ink/settings.json" || /^\.common-ink\/users\/[^/]+\/settings\.json$/.test(path) || path.startsWith(".common-ink/extensions/");

export type Decision = { outcome: "allow" | "deny" | "ask"; key: string } | { outcome: "undeclared" };

/**
 * What to do about an ask: allowed or denied by an answer you gave, allowed for a built-in you haven't
 * denied, or ask you. Asks the manifest doesn't declare can never be allowed.
 */
export function decide(m: ExtensionManifest, ask: Ask, grants: Grants, opts: { builtIn: boolean; once?: ReadonlySet<string> } = { builtIn: false }): Decision {
  const key = coveringKey(m, ask);
  if (!key) return { outcome: "undeclared" };
  const answer = grants[m.id]?.[key];
  if (answer) return { outcome: answer, key };
  if (opts.builtIn || opts.once?.has(`${m.id} ${key}`)) return { outcome: "allow", key };
  return { outcome: "ask", key };
}

/** The grants kept in a settings value, as far as they're well formed. */
export function parseGrants(value: unknown): Grants {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Grants = {};
  for (const [id, answers] of Object.entries(value as Record<string, unknown>)) {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) continue;
    const kept = Object.entries(answers as Record<string, unknown>).filter((e): e is [string, Answer] => e[1] === "allow" || e[1] === "deny");
    if (kept.length) out[id] = Object.fromEntries(kept);
  }
  return out;
}
