// The page's address names the file on show: ?file=<exact path>, for any File (notes, settings,
// layout). Older links said ?note=; they're read the same way. It's never resolved like a [[link]].
import { parseFilePath, type FilePath } from "../../worker/src/files.ts";

export function fileFromUrl(search: string): FilePath | null {
  const params = new URLSearchParams(search);
  return parseFilePath(params.get("file") ?? params.get("note"));
}

export function urlForFile(path: FilePath): string {
  return `?file=${encodeURIComponent(path)}`;
}
