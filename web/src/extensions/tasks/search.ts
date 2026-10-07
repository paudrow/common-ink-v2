// Tasks in search (contributes.search): a task matches the query's words in what it says, `is:open` or
// `is:done`, and `in:` its note's folder. Any other filter is one tasks don't have, so none match it.
import { inGlobs, matchesWords, type Query } from "common-ink/query";
import type { Task } from "./tasks.ts";

/** The tasks a query finds: open ones first, then by due day, in note order; with `within`, only those in notes whose paths match one of those globs. */
export function findTasks(tasks: readonly Task[], query: Query, within?: readonly string[]): Task[] {
  const inside = within ? inGlobs(within) : () => true;
  const filters = query.terms.flatMap((t) => (t.kind === "filter" && t.value ? [t] : []));
  const states = filters.filter((f) => f.key === "is");
  const folders = filters.filter((f) => f.key === "in" && !f.negated).map((f) => `${f.value.replace(/\/+$/, "").toLowerCase()}/`);
  if (filters.some((f) => (f.key !== "is" && f.key !== "in") || (f.key === "is" && !["open", "done"].includes(f.value.toLowerCase())))) return [];
  const inFolder = (t: Task, folder: string) => t.path.toLowerCase().startsWith(folder);
  return tasks
    .filter((t) => inside(t.path) && matchesWords(query, t.summary || t.text))
    .filter((t) => states.every((s) => (s.value.toLowerCase() === "done") === t.done !== s.negated))
    .filter((t) => (!folders.length || folders.some((f) => inFolder(t, f))) && filters.every((f) => f.key !== "in" || !f.negated || !inFolder(t, `${f.value.replace(/\/+$/, "").toLowerCase()}/`)))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(a.t.done) - Number(b.t.done) || (a.t.meta.due ?? "9999").localeCompare(b.t.meta.due ?? "9999") || a.i - b.i)
    .map(({ t }) => t);
}
