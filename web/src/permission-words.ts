// Permissions in plain words, for every place the app shows one: what a declared permission lets an
// extension do ("Read all your notes"), with the real reach of its scope and friendly names for the
// files it names ("User settings", never .common-ink/users/…). Names are marked, so a page can set
// them apart; as text they read as they are.
import { PERMISSION_KINDS, type ExtensionManifest, type PermissionKind } from "../../worker/src/extensions.ts";
import { isNote, type FilePath } from "../../worker/src/files.ts";
import { docLabel } from "./describe.ts";

/** Words, with the names in them marked: a note's title, a file's friendly name, a host. */
export type Phrase = Array<string | { name: string }>;

/** A phrase as plain text. */
export const plain = (p: Phrase): string => p.map((part) => (typeof part === "string" ? part : part.name)).join("");

/** A phrase as page content: names in <em>. */
export const nodes = (p: Phrase): Array<string | HTMLElement> =>
  p.map((part) => {
    if (typeof part === "string") return part;
    const em = document.createElement("em");
    em.textContent = part.name;
    return em;
  });

/** The phrase with its first letter capitalized, to start a sentence. */
export function capitalized(p: Phrase): Phrase {
  const [first, ...rest] = p;
  if (typeof first !== "string" || !first) return p;
  return [first[0].toUpperCase() + first.slice(1), ...rest];
}

/** What to call one file: "the note This week", "User settings", "the file photos/cat.png". */
export function fileWords(path: string): Phrase {
  const label = docLabel(path as FilePath);
  if (isNote(path as FilePath)) return ["the note ", { name: label }];
  if (label !== path) return [{ name: label }];
  return ["the file ", { name: path }];
}

/** How far a glob over paths reaches, in words: "all your notes", "everything in Journal". */
export function filesWords(glob: string): Phrase {
  if (glob === "**") return ["all your files, including settings"];
  if (glob === "**/*.md") return ["all your notes"];
  if (glob === ".common-ink/**") return ["your settings and the app's own files"];
  const notesIn = /^([^*?]+)\/\*\*\/\*\.md$/.exec(glob);
  if (notesIn) return ["your notes in ", { name: notesIn[1] }];
  const allIn = /^([^*?]+)\/\*\*$/.exec(glob);
  if (allIn) return ["everything in ", { name: allIn[1] }];
  if (!/[*?]/.test(glob)) return fileWords(glob);
  return ["files matching ", { name: glob }];
}

/** A host an extension may connect to, or a pattern of them, in words. */
export function hostWords(host: string): Phrase {
  if (host === "*") return ["any site"];
  if (host.startsWith("*.")) return ["any site under ", { name: host.slice(2) }];
  return [{ name: host }];
}

/** Doing something of a kind, to a scope or a thing, in lowercase: "read all your notes", "connect to api.weather.gov". */
export function doing(kind: PermissionKind, what: Phrase = []): Phrase {
  switch (kind) {
    case "network":
      return ["connect to ", ...what];
    case "files:read":
      return ["read ", ...what];
    case "files:write":
      return ["change ", ...what];
    case "settings:write":
      return ["change the setting ", ...what];
    case "clipboard:read":
      return ["read your clipboard"];
    case "clipboard:write":
      return ["copy to your clipboard"];
    case "notifications":
      return ["show notifications"];
    case "media":
      return ["play sound"];
    case "history:read":
      return ["read the history of your files"];
    case "calendar:read":
      return ["read your calendar"];
    case "contacts:read":
      return ["read your contacts"];
    case "editor":
      return ["change how notes are edited and drawn"];
  }
}

/**
 * A few of the app's files are better said by what changing them does: "save files you upload (Uploads
 * list)". Others are read or changed by their friendly names.
 */
const SAID: Record<string, Partial<Record<PermissionKind, Phrase>>> = {
  ".common-ink/uploads.json": { "files:write": ["save files you upload (", { name: "Uploads list" }, ")"] },
};

/** What a declared scope lets it do: "read all your notes", "connect to any site". */
export function scopeWords(kind: PermissionKind, scope?: string): Phrase {
  if (scope === undefined) return doing(kind);
  const said = SAID[scope]?.[kind];
  if (said) return said;
  if (kind === "network") return doing(kind, hostWords(scope));
  if (kind === "settings:write") return doing(kind, [{ name: scope }]);
  return doing(kind, filesWords(scope));
}

/** One declared permission, as answers are kept (its key) and as the app says it. */
export interface DeclaredPermission {
  /** "files:read:**", or the kind alone for one without a scope. */
  key: string;
  kind: PermissionKind;
  scope?: string;
  /** "Read all your notes". */
  can: Phrase;
  /** The extension's own reason. */
  why: string;
}

/** Each permission a manifest declares, one per scope, in the order kinds are listed. */
export function declaredPermissions(m: ExtensionManifest): DeclaredPermission[] {
  return PERMISSION_KINDS.flatMap((kind) => {
    const p = m.permissions[kind];
    if (!p) return [];
    const scopes: Array<string | undefined> = p.hosts ?? p.paths ?? p.keys ?? [undefined];
    return scopes.map((scope) => ({ key: scope === undefined ? kind : `${kind}:${scope}`, kind, scope, can: capitalized(scopeWords(kind, scope)), why: p.why }));
  });
}
