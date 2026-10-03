import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { storeFile } from "./files";
import { getSettings, setSetting } from "./settings";

/**
 * The pharmacy's own mark, on the things it hands to other people.
 *
 * Everything this system produces goes somewhere: an invoice to an accounts department, a
 * technician list to the Board, a training certificate to a member of staff, a policy manual to an
 * inspector. Every one of those arrives looking like a printout from a database, and a printout is
 * read as a draft. A letterhead is not decoration — it is the difference between a document that
 * looks like a record the pharmacy keeps and one that looks like something somebody typed up this
 * morning.
 *
 * One image, held once, used everywhere it belongs. Not on the Board's own forms — a C-900 is the
 * Board's document and putting a pharmacy logo on it would be altering a state form — and not on
 * anything where the pharmacy is filling in somebody else's paper.
 */

export type Logo = { documentId: string; url: string; mimeType: string; fileName: string } | null;

export async function logo(): Promise<Logo> {
  const s = await getSettings();
  const id = (s.logo_document_id ?? "").trim();
  if (!id) return null;
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, id) });
  if (!doc) return null;
  return { documentId: doc.id, url: `/files/${doc.id}`, mimeType: doc.mimeType, fileName: doc.fileName };
}

/** Only what a browser will actually draw. A HEIC from a phone will not display on a printed page. */
const DRAWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);

export async function saveLogo(file: File, user: { id: string; name: string }): Promise<string> {
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose an image file.");
  const type = file.type || "";
  if (!DRAWABLE.has(type)) {
    throw new Error(
      "Use a PNG, JPG, SVG or WebP. A HEIC from an iPhone will upload but will not draw on a printed page — open it " +
        "and export it as PNG first.",
    );
  }
  // Small on purpose: this is drawn at about half an inch on a printed page and in a sidebar. A
  // ten-megapixel photograph would be carried in every backup for no visible benefit.
  if (file.size > 3 * 1024 * 1024) throw new Error("That image is larger than 3 MB. A logo does not need to be.");

  const stored = await storeFile(file, { folder: "branding" });
  const id = newId();
  await db.insert(schema.documents).values({
    id,
    category: "policy",
    title: "Pharmacy logo",
    fileName: file.name,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    uploadedBy: user.id,
    notes: `Uploaded by ${user.name} as the pharmacy's logo.`,
  });
  await setSetting("logo_document_id", id);
  return id;
}

/**
 * Stops using a logo without deleting the file.
 *
 * The document stays in the vault. Removing the row would break the backup's record of what was
 * held and when, and an image somebody uploaded is not rubbish just because it is no longer the
 * one in use.
 */
export async function clearLogo(): Promise<void> {
  await setSetting("logo_document_id", "");
}
