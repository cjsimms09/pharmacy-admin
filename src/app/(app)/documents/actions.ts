"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteFile, storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { DOCUMENT_CATEGORIES } from "@/db/schema";

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => (v ? v : null));

const uploadSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  title: z.string().trim().min(1).max(200),
  personId: z.string().optional().transform((v) => (v ? v : null)),
  credentialId: z.string().optional().transform((v) => (v ? v : null)),
  cqiSummaryId: z.string().optional().transform((v) => (v ? v : null)),
  cqiIncidentId: z.string().optional().transform((v) => (v ? v : null)),
  effectiveOn: optDate,
  expiresOn: optDate,
  notes: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
  redirectTo: z.string().optional(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function uploadDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireManager();
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file to upload." };
  const parsed = uploadSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { ok: false, error: "Check the form: " + parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") };
  const d = parsed.data;
  try {
    const stored = await storeFile(file);
    const id = newId();
    await db.insert(schema.documents).values({
      id,
      category: d.category,
      title: d.title,
      fileName: file.name.slice(0, 200),
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      personId: d.personId,
      credentialId: d.credentialId,
      cqiSummaryId: d.cqiSummaryId,
      cqiIncidentId: d.cqiIncidentId,
      effectiveOn: d.effectiveOn,
      expiresOn: d.expiresOn,
      notes: d.notes,
      uploadedBy: user.id,
    });
    await audit({ action: "document.upload", userId: user.id, userName: user.name, entity: "document", entityId: id, details: `${d.category}: ${d.title}` });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed." };
  }
  revalidatePath("/documents");
  revalidatePath("/staff");
  revalidatePath("/cqi");
  if (d.redirectTo) revalidatePath(d.redirectTo);
  return { ok: true };
}

export async function deleteDocument(id: string, redirectTo?: string): Promise<ActionResult> {
  const user = await requireManager();
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, id) });
  if (!doc) return { ok: false, error: "Document not found." };
  await db.delete(schema.documents).where(eq(schema.documents.id, id));
  await deleteFile(doc.storageKey);
  await audit({ action: "document.delete", userId: user.id, userName: user.name, entity: "document", entityId: id, details: doc.title });
  revalidatePath("/documents");
  if (redirectTo) revalidatePath(redirectTo);
  return { ok: true };
}
