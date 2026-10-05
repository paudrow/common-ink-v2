// Permissions in plain words, for every place the app shows one: what a declared permission lets an
// extension do ("Read all your notes"), with the real reach of its scope and friendly names for the
// files it names ("User settings", never .common-ink/users/…). Names are marked, so a page can set
// them apart; as text they read as they are.
import { PERMISSION_KINDS, type ExtensionManifest, type PermissionKind } from "../../worker/src/extensions.ts";
import type { Ask } from "../../worker/src/permissions.ts";
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

/** Each kind's verb, as "do it", "did it" and "doing it": what follows is what it's done to, if anything. */
const VERBS: Record<PermissionKind, [base: string, past: string, ing: string]> = {
  network: ["connect to", "connected to", "connecting to"],
  "files:read": ["read", "read", "reading"],
  "files:write": ["change", "changed", "changing"],
  "settings:write": ["change the setting", "changed the setting", "changing the setting"],
  "clipboard:read": ["read your clipboard", "read your clipboard", "reading your clipboard"],
  "clipboard:write": ["copy to your clipboard", "copied to your clipboard", "copying to your clipboard"],
  notifications: ["show notifications", "showed a notification", "showing a notification"],
  media: ["play sound", "played sound", "playing sound"],
  "history:read": ["read the history of your files", "read the history of your files", "reading the history of your files"],
  "data:calendar:read": ["see your calendar's events", "saw your calendar's events", "seeing your calendar's events"],
  "data:calendar:write": ["add, change and delete events in your calendar", "changed an event in your calendar", "changing an event in your calendar"],
  "data:contacts:read": ["see your contacts", "saw your contacts", "seeing your contacts"],
  editor: ["change how notes are edited and drawn", "changed how notes are edited and drawn", "changing how notes are edited and drawn"],
};

export type Tense = "base" | "past" | "ing";

/** Doing something of a kind, to a scope or a thing, in lowercase: "read all your notes", "connected to api.weather.gov". */
export function doing(kind: PermissionKind, what: Phrase = [], tense: Tense = "base"): Phrase {
  const verb = VERBS[kind][tense === "base" ? 0 : tense === "past" ? 1 : 2];
  return what.length ? [`${verb} `, ...what] : [verb];
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
  return SAID[scope]?.[kind] ?? doing(kind, scopeObject(kind, scope));
}

/** What a scope reaches, as the object of its verb: "all your notes", "any site", a setting's key. */
function scopeObject(kind: PermissionKind, scope: string): Phrase {
  if (kind === "network") return hostWords(scope);
  if (kind === "settings:write") return [{ name: scope }];
  return filesWords(scope);
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

/** What you can answer, as every place says it: in a prompt, the Extensions view and the activity log. */
export const ANSWER_WORDS = { ask: "Ask", allow: "Always allow", deny: "Don't allow" } as const;

/** One thing an extension wants to do now, about what it's for: "read the note This week", "connect to api.weather.gov". */
export function askWords(ask: Ask, tense: Tense = "base"): Phrase {
  if (ask.target !== undefined) {
    const thing = ask.kind === "network" ? hostWords(ask.target) : ask.kind === "settings:write" ? [{ name: ask.target }] : fileWords(ask.target);
    return doing(ask.kind, thing, tense);
  }
  if (ask.scope !== undefined) return tense === "base" ? scopeWords(ask.kind, ask.scope) : doing(ask.kind, scopeObject(ask.kind, ask.scope), tense);
  return doing(ask.kind, [], tense);
}

/** What you did that an extension is acting on: why it asks now. */
export type Trigger =
  | { kind: "command"; title: string }
  | { kind: "view"; name: string }
  | { kind: "opened"; path: string }
  | { kind: "embed"; title: string; note: string | null }
  | { kind: "installed" | "turnedOn" }
  | { kind: "startup" };

/** Why an extension asks now, as the end of a sentence: "because you ran Show word count". */
export function triggerWords(t: Trigger | null): Phrase {
  if (!t) return ["on its own, not right after anything you did"];
  switch (t.kind) {
    case "command":
      return ["because you ran ", { name: t.title }];
    case "view":
      return ["to show its ", { name: t.name }, " view"];
    case "opened":
      return ["because you switched to ", ...fileWords(t.path)];
    case "embed":
      return t.note ? ["to draw the ", { name: t.title }, " embed in ", ...fileWords(t.note)] : ["to draw its ", { name: t.title }, " embed"];
    case "installed":
      return ["because you just installed it"];
    case "turnedOn":
      return ["because you just turned it on"];
    case "startup":
      return ["as the app started"];
  }
}

/** Why something an extension tried was refused. */
export type Refusal =
  /** Your kept answer, Don't allow, for the scope it falls in. */
  | { reason: "answer"; scope: Phrase }
  /** Don't allow for now: Escape on its prompt. */
  | { reason: "now" }
  /** Its manifest doesn't ask for it: the scopes of that kind it does ask for, if any. */
  | { reason: "undeclared"; scopes: string[] };

/** "Word count can't read User settings: it only asked to read all your notes." */
export function refusedWords(name: string, ask: Ask, refusal: Refusal): Phrase {
  const tried: Phrase = [name, " can't ", ...askWords(ask)];
  switch (refusal.reason) {
    case "answer":
      return [...tried, ": you don't allow it to ", ...refusal.scope, "."];
    case "now":
      return [...tried, ": you didn't allow it this time."];
    case "undeclared":
      if (!refusal.scopes.length) return [...tried, ": it never asked for that."];
      return [...tried, ": it only asked to ", ...doing(ask.kind, joined(refusal.scopes.map((scope) => scopeObject(ask.kind, scope)), " or ")), "."];
  }
}

/** Phrases one after another, with `and` (or "or") before the last. */
function joined(phrases: Phrase[], and: string): Phrase {
  return phrases.flatMap((p, i) => [...(i === 0 ? [] : [i === phrases.length - 1 ? and : ", "]), ...p]);
}

/** Where to change what an extension may do: "Extensions → Word count". */
export const changeIn = (name: string) => `Extensions → ${name}`;
