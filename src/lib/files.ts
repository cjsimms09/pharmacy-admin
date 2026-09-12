import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { newId, sha256 } from "./crypto";

export const filesDir = () => process.env.FILES_DIR ?? "./data/files";

/**
 * What may be uploaded, decided by extension as well as by type.
 *
 * The browser's idea of a file's type cannot be relied on. An iPhone photo arrives as image/heif
 * on one device and image/heic on another; a scan from a copier is image/tiff; and Windows sends
 * application/octet-stream whenever it does not recognise the extension. Judging on type alone
 * meant a pharmacist photographing a licence card was told "file type not allowed" for a
 * perfectly ordinary photo — which is exactly the kind of refusal that makes someone give up on
 * the whole feature.
 *
 * So the extension is authoritative for what is allowed, and the reported type is kept as a
 * label. Nothing here is executed or rendered as markup; files are stored opaquely and served
 * back as downloads, so the risk this list manages is clutter rather than code execution.
 */
export const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff",
  "doc", "docx", "rtf", "odt",
  "txt",
]);

/** Report formats the swept mailbox may also bring in. */
export const REPORT_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "xml", "json", "835", "edi", "x12", "zip"]);

export const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/plain",
]);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

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
  opts: {
    allowReportTypes?: boolean;
    /**
     * A folder of its own, for records the law requires to be kept apart.
     *
     * 21 CFR 1304.04(h)(1) says Schedule II records are maintained separately from all other
     * records of the registrant. A category on a row is enough to retrieve them; a directory
     * makes the separation true of the bytes as well, which is what somebody copying the files
     * off this machine — for a backup, for an inspection, for a new system — would rely on.
     */
    folder?: string;
  } = {},
): Promise<{ storageKey: string; sha256: string; sizeBytes: number; mimeType: string }> {
  if (file.size === 0) throw new Error("The file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 20 MB.");
  const mimeType = file.type || "application/octet-stream";
  const ext = extensionOf(file.name);
  const allowedExt = opts.allowReportTypes ? ALLOWED_EXTENSIONS.has(ext) || REPORT_EXTENSIONS.has(ext) : ALLOWED_EXTENSIONS.has(ext);
  const allowedMime = opts.allowReportTypes ? ALLOWED_MIME.has(mimeType) || REPORT_MIME.has(mimeType) : ALLOWED_MIME.has(mimeType);

  // Either is enough. A recognised extension covers the photo whose type the phone got wrong;
  // a recognised type covers the file that arrived with no extension at all.
  if (!allowedExt && !allowedMime) {
    throw new Error(
      ext
        ? `Files ending .${ext} are not accepted. Use a PDF, a photo (JPG, PNG, HEIC), a scan (TIFF) or a Word document.`
        : "That file has no extension, so there is no way to tell what it is. Rename it with the right ending and try again.",
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = sha256(buf);
  const safeFolder = (opts.folder ?? "").replace(/[^a-z0-9-]/gi, "");
  const key = `${safeFolder ? `${safeFolder}/` : ""}${new Date().getUTCFullYear()}/${newId()}`;
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

/**
 * Stores text the site generated or received, rather than a file somebody uploaded.
 *
 * Kept separate from storeFile on purpose. storeFile exists to be suspicious of what a browser
 * hands it; this is for content that never came from a browser — an emailed attestation captured
 * verbatim, a generated log. The allow-list would refuse it for the wrong reason, and loosening
 * the allow-list to let it through would weaken the check that matters.
 */
export async function storeRawText(text: string): Promise<{ storageKey: string; sha256: string; sizeBytes: number; mimeType: string }> {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error("That message is larger than 20 MB.");
  // Same layout as an upload, so one route serves everything and nothing has to know where a
  // particular document came from.
  const key = `${new Date().getUTCFullYear()}/${newId()}`;
  const full = path.join(filesDir(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { mode: 0o600 });
  return { storageKey: key, sha256: sha256(buf), sizeBytes: buf.byteLength, mimeType: "text/plain" };
}
