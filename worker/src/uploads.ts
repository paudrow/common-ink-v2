// Uploads: images, PDFs and other binary files, referenced from notes as /uploads/<name>. The bytes
// live in R2 under their SHA-256, so the same file uploaded twice is kept once. Which names exist is a
// JSON file in the workspace, .common-ink/uploads.json, so each upload is a change with an author:
// it shows in history, and undo takes it back (the bytes stay in R2, so redo can bring it back).
import { parseFilePath, type Author, type Files, type WriteResult } from "./files.ts";

export const UPLOADS_PATH = parseFilePath(".common-ink/uploads.json")!;

/** Larger than this is refused: a Durable Object call carries at most 32 MiB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface Upload {
  /** Its name in the workspace, and so its address: /uploads/<name>. */
  name: string;
  /** SHA-256 of the bytes, hex: the R2 key is "blobs/<hash>". */
  hash: string;
  size: number;
  type: string;
}

/** Where the bytes live: R2 in the Worker, a Map in tests. */
export interface Blobs {
  has(key: string): Promise<boolean>;
  put(key: string, data: ArrayBuffer, type: string): Promise<void>;
}

export const blobKey = (hash: string) => `blobs/${hash}`;
export const uploadUrl = (name: string) => `/uploads/${encodeURIComponent(name)}`;

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  zip: "application/zip",
};

/** A file's type, from its name's extension: what the page and the browser are told. */
export function typeFor(name: string): string {
  return TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Types a browser may show in the page; anything else downloads. All of them are served sandboxed. */
export const showsInline = (type: string) => /^(image|audio|video)\//.test(type) || type === "application/pdf" || type === "text/plain";

export const isImage = (type: string) => type.startsWith("image/");

/** An uploaded file's name made safe to be an address: no folders, no control characters, at most 120 characters. Null if nothing's left. */
export function cleanName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Control characters and the characters links and markdown would trip on.
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*#%[\]()`]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!clean) return null;
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  return `${stem.slice(0, 120 - ext.length)}${ext.toLowerCase()}`;
}

/** The uploads in the uploads file. Entries that aren't uploads are skipped. */
export function parseUploads(text: string): Upload[] {
  let data: unknown;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    return [];
  }
  const list = (data as { uploads?: unknown })?.uploads;
  if (!Array.isArray(list)) return [];
  return list.flatMap((u) =>
    u && typeof u.name === "string" && /^[0-9a-f]{64}$/.test(u.hash) && Number.isSafeInteger(u.size) && typeof u.type === "string"
      ? [{ name: u.name, hash: u.hash, size: u.size, type: u.type }]
      : [],
  );
}

/** The uploads file's text: one upload per line, so changes to it merge and diff by upload. */
export function uploadsText(uploads: Upload[]): string {
  if (!uploads.length) return `{\n  "uploads": []\n}\n`;
  return `{\n  "uploads": [\n${uploads.map((u) => `    ${JSON.stringify(u)}`).join(",\n")}\n  ]\n}\n`;
}

/**
 * The name an upload gets: its own, unless another file has it, then "photo-2.png" and so on. The
 * same bytes under the same name are the upload that's there already.
 */
export function placeName(uploads: readonly Upload[], name: string, hash: string): { name: string; existing: boolean } {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const taken = uploads.find((u) => u.name === candidate);
    if (!taken) return { name: candidate, existing: false };
    if (taken.hash === hash) return { name: candidate, existing: true };
  }
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type UploadResult = { status: "uploaded" | "existing"; upload: Upload; url: string; change?: WriteResult } | { status: "refused"; error: string };

/** Keep the bytes (once), then record the upload in the uploads file as a change by `author`. */
export async function addUpload(files: Files, blobs: Blobs, rawName: string, data: ArrayBuffer, author: Author): Promise<UploadResult> {
  const cleaned = cleanName(rawName);
  if (!cleaned) return { status: "refused", error: "An upload needs a file name" };
  if (data.byteLength === 0) return { status: "refused", error: `${cleaned} is empty` };
  if (data.byteLength > MAX_UPLOAD_BYTES) return { status: "refused", error: `${cleaned} is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` };
  const hash = await sha256(data);
  const type = typeFor(cleaned);
  try {
    if (!(await blobs.has(blobKey(hash)))) await blobs.put(blobKey(hash), data, type);
  } catch (err) {
    console.error("Storing an upload's bytes failed:", err);
    return { status: "refused", error: `${cleaned} wasn't uploaded: uploads can't be stored right now. Try again in a minute.` };
  }
  // Reading and writing the uploads file happen together, with nothing awaited in between, so two
  // uploads can't both take the same name.
  const current = files.read(UPLOADS_PATH);
  const uploads = parseUploads(current?.text ?? "");
  const { name, existing } = placeName(uploads, cleaned, hash);
  const upload: Upload = { name, hash, size: data.byteLength, type };
  if (existing) return { status: "existing", upload: uploads.find((u) => u.name === name)!, url: uploadUrl(name) };
  const change = files.write({ path: UPLOADS_PATH, text: uploadsText([...uploads, upload]), base: current?.revision ?? 0, author });
  return { status: "uploaded", upload, url: uploadUrl(name), change };
}

/** The upload with this name, if there is one. */
export function findUpload(text: string, name: string): Upload | null {
  return parseUploads(text).find((u) => u.name === name) ?? null;
}
