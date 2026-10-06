// Reading a request's body with a limit, for the upload route (index.ts).

/**
 * A request body's bytes, or null if there are more than `max`: it stops reading there, so a body
 * without a Content-Length can't fill the Worker's memory.
 */
export async function bytesUpTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<ArrayBuffer | null> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(read.value);
  }
  const out = new Uint8Array(size);
  parts.reduce((at, part) => (out.set(part, at), at + part.byteLength), 0);
  return out.buffer;
}
