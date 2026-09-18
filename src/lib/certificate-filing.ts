import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { TRAINING_LABEL } from "./labels";
import { certificateFor } from "./certificate";
import { certificatePdf, certificateFileName } from "./certificate-pdf";

/**
 * Filing a copy of a certificate under Documents.
 *
 * The live certificate stays the authority — it is generated from the record every time, so it
 * cannot drift from the register. This is a copy, and it is labelled as one, with the verification
 * code that was current when it was taken. If the record changes afterwards the codes stop
 * matching, which is the point: a filed copy can become visibly older but never silently wrong.
 *
 * Filing the same certificate twice is refused rather than allowed to accumulate. A folder with
 * four copies of one certificate is a folder where nobody can say which one is the record.
 */
export async function fileCertificate(
  trainingId: string,
  user: { name: string },
): Promise<{ documentId: string; fileName: string }> {
  const c = await certificateFor(trainingId);
  if (!c) throw new Error("There is no training record behind that certificate.");

  const t = await db.query.trainings.findFirst({ where: eq(schema.trainings.id, trainingId) });
  if (!t) throw new Error("There is no training record behind that certificate.");

  const fileName = certificateFileName(c);
  const existing = await db.query.documents.findMany({
    where: eq(schema.documents.category, "training_record"),
  });
  const already = existing.find((d) => d.fileName === fileName);
  if (already) {
    throw new Error(
      `A copy of this certificate is already filed, taken on ${already.uploadedAt.slice(0, 10)}. ` +
        `Open it from Documents rather than filing a second one.`,
    );
  }

  const pdf = certificatePdf(c);
  const { storeFile } = await import("./files");
  const stored = await storeFile(new File([new Uint8Array(pdf)], fileName, { type: "application/pdf" }));

  const documentId = newId();
  await db.insert(schema.documents).values({
    id: documentId,
    category: "training_record",
    title: `${TRAINING_LABEL[t.type]} — certificate for ${c.personName}`,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    personId: t.personId,
    effectiveOn: t.completedOn,
    expiresOn: t.expiresOn,
    notes:
      `Filed copy of certificate ${c.number}, taken ${todayIso()} by ${user.name}. ` +
      `Verification code at the time of filing: ${c.verification}. The live certificate is generated from the ` +
      `record and remains the authority; if its code no longer matches this one, the record has changed since.`,
    uploadedBy: user.name,
  });

  return { documentId, fileName };
}
