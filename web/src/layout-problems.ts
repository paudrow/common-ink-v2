// What's untidy about a layout (layout.ts), for property tests and the app's own checks with test levers
// on (docs/TESTING.md): every function in layout.ts keeps a layout tidy, so a problem here is a bug there.
import { openableKey, type GroupId, type Layout, type Node } from "./layout.ts";
/** What's untidy about a layout, in words: nothing for one the functions here made. */
export function layoutProblems(layout: Layout): string[] {
  const problems: string[] = [];
  const ids = new Set<GroupId>();
  const walk = (n: Node, at: string) => {
    if (n.kind === "group") {
      if (!/^g\d+$/.test(n.id)) problems.push(`${at}: group id "${n.id}" isn't g and a number`);
      if (ids.has(n.id)) problems.push(`${at}: group id ${n.id} is used twice`);
      ids.add(n.id);
      if (n.tabs.length ? !(Number.isInteger(n.active) && n.active >= 0 && n.active < n.tabs.length) : n.active !== 0) problems.push(`${at}: active ${n.active} of ${n.tabs.length} tabs`);
      if (new Set(n.tabs.map(openableKey)).size < n.tabs.length) problems.push(`${at}: the same tab twice`);
      if (n.tabs.filter((t) => t.preview).length > 1) problems.push(`${at}: more than one preview tab`);
      return;
    }
    if (n.children.length < 2) problems.push(`${at}: a split of ${n.children.length}`);
    if (n.sizes.length !== n.children.length) problems.push(`${at}: ${n.sizes.length} sizes for ${n.children.length} children`);
    if (!n.sizes.every((s) => s > 0)) problems.push(`${at}: a size that isn't positive (${n.sizes.join(", ")})`);
    const total = n.sizes.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 1e-9) problems.push(`${at}: sizes add up to ${total}`);
    n.children.forEach((c, i) => {
      if (c.kind === "split" && c.dir === n.dir) problems.push(`${at}.${i}: a ${c.dir} split inside a ${n.dir} split`);
      walk(c, `${at}.${i}`);
    });
  };
  walk(layout.root, "root");
  if (!ids.has(layout.focus)) problems.push(`focus "${layout.focus}" names no group`);
  return problems;
}
