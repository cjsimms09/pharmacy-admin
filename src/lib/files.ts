import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { newId, sha256 } from "./crypto";

const filesDir = () => process.env.FILES_DIR ?? "./data/files";

export const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Report formats accepted from the swept mailbox in addition to the upload types above. */
export const REPORT_MIME = new Set([
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

export async function storeFile(
  file: File,
  opts: { allowReportTypes?: boolean } = {},
): Promise<{ storageKey: string; sha256: string; sizeBytes: number; mimeType: string }> {
  if (file.size === 0) throw new Error("The file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 20 MB.");
  const mimeType = file.type || "application/octet-stream";
  const allowed = opts.allowReportTypes ? ALLOWED_MIME.has(mimeType) || REPORT_MIME.has(mimeType) : ALLOWED_MIME.has(mimeType);
  if (!allowed) throw new Error(`File type not allowed (${mimeType}). Upload a PDF, image, or Word document.`);
  const buf = Buffer.from(await file.arrayBuffer());
  const hash = sha256(buf);
  const key = `${new Date().getUTCFullYear()}/${newId()}`;
  const full = path.join(filesDir(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { mode: 0o600 });
  return { storageKey: key, sha256: hash, sizeBytes: buf.length, mimeType };
}

export async function readFile(storageKey: string): Promise<Buffer> {
  if (storageKey.includes("..")) throw new Error("Invalid key");
  return fs.readFile(path.join(filesDir(), storageKey));
}

export async function deleteFile(storageKey: string): Promise<void> {
  if (storageKey.includes("..")) throw new Error("Invalid key");
  await fs.rm(path.join(filesDir(), storageKey), { force: true });
}
