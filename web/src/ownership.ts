// Who owns each name extensions register things under: a command id, a view id, an embed's language, a
// status item, a command bar prefix. One rule for all of them, which every registry keyed by such a name
// consults, as things are registered and again as they're used:
//
// - An extension that runs in the page (a built-in, or one you trust) owns every name its manifest
//   declares, from the moment extensions load, before it starts, but not while you've turned it off. A built-in keeps its own names against any other; between two others, the first listed
//   keeps it.
// - A sandboxed extension owns a name only if no extension in the page declares it, and it's the first
//   sandboxed one that's on and declares it.
//
// What else names a command or a view (keys, menus, a status item's click) reaches
// it only while it's owned by the extension that contributes it.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import { namesOf, type ExtensionRecord } from "./extension-host.ts";

export type NameKind = "command" | "view" | "embed" | "statusItem" | "prefix";

/** The names of each kind a manifest declares. A new kind of name needs a row here, and one in the ownership test's table. */
export const DECLARED: { [K in NameKind]: (m: ExtensionManifest) => readonly string[] } = {
  command: (m) => m.contributes.commands.map((c) => c.command),
  view: (m) => Object.values(m.contributes.views).flat().map((v) => v.id),
  embed: (m) => m.contributes.embeds.map((e) => e.language),
  statusItem: (m) => m.contributes.statusBarItems.map((i) => i.id),
  // A command bar prefix starts with its extension's name, as a word (ownPrefix): the names are its id's.
  prefix: (m) => namesOf(m.id).map((n) => n.toLowerCase()),
};

/** A command bar prefix's name: the word it starts with, as `DECLARED.prefix` names them. */
export const prefixName = (prefix: string) => /^[\w.-]*/.exec(prefix.toLowerCase())![0];

export class Ownership {
  constructor(private records: () => readonly ExtensionRecord[]) {}

  /** The id of the extension that owns a name, if one does. */
  owner(kind: NameKind, name: string): string | undefined {
    const declares = (r: ExtensionRecord) => DECLARED[kind](r.manifest).includes(name);
    const records = this.records();
    const page = records.filter((r) => r.tier === "page" && !r.broken && r.state !== "off" && declares(r));
    const held = page.find((r) => r.builtIn) ?? page[0];
    if (held) return held.id;
    return records.find((r) => r.tier === "sandbox" && (r.state === "inactive" || r.state === "active") && declares(r))?.id;
  }

  owns(extension: string, kind: NameKind, name: string): boolean {
    return this.owner(kind, name) === extension;
  }

  /** A registry of what extensions register under names of one kind. */
  registry<T>(kind: NameKind): Owned<T> {
    return new Owned<T>(this, kind);
  }
}

/** What extensions register under names, each kept with the extension that registered it, and found only while that extension owns the name. */
export class Owned<T> {
  private entries = new Map<string, { owner: string; value: T }>();

  constructor(
    private ownership: Ownership,
    private kind: NameKind,
  ) {}

  /** Keep `value` under `name` for `owner`. False, and nothing kept, if it doesn't own the name. */
  set(owner: string, name: string, value: T): boolean {
    if (!this.ownership.owns(owner, this.kind, name)) return false;
    this.entries.set(name, { owner, value });
    return true;
  }

  /** What's kept under `name`, if the extension that kept it owns the name now, and is `owner` when that's given. */
  get(name: string, owner?: string): T | undefined {
    const entry = this.entries.get(name);
    if (!entry || (owner !== undefined && entry.owner !== owner) || !this.ownership.owns(entry.owner, this.kind, name)) return undefined;
    return entry.value;
  }
}
