// Globs over paths, as extensions' files:read and files:write scopes and search's `within` give them.

/** A glob over paths: "**" any number of folders, "*" anything within a name, "?" one character. */
export function globMatches(glob: string, path: string): boolean {
  return globRegExp(glob).test(path);
}

/**
 * Whether some globs admit a path. The first glob it matches decides: a glob admits it, a "!glob" leaves
 * it out; one none match is left out. So ["!Secret/**", "**"] is everything but Secret/, and it's how
 * an extension's files:read scopes are decided too, by the first declared scope that covers a path.
 */
export function inGlobs(globs: readonly string[]): (path: string) => boolean {
  const rules = globs.map((g) => (g.startsWith("!") ? { admit: false, re: globRegExp(g.slice(1)) } : { admit: true, re: globRegExp(g) }));
  return (path) => rules.find((r) => r.re.test(path))?.admit ?? false;
}

function globRegExp(glob: string): RegExp {
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
  return new RegExp(`^${re}$`);
}
