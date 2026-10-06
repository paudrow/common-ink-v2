// Globs over paths, as extensions' files:read and files:write scopes and search's `within` give them.

/** A glob over paths: "**" any number of folders, "*" anything within a name, "?" one character. */
export function globMatches(glob: string, path: string): boolean {
  return globRegExp(glob).test(path);
}

/** Whether a path matches any of some globs, with each glob read once. */
export function inGlobs(globs: readonly string[]): (path: string) => boolean {
  const res = globs.map(globRegExp);
  return (path) => res.some((re) => re.test(path));
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
