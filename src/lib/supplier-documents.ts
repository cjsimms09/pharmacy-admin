import "server-only";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { storeFile } from "./files";

/**
 * Keeping the supplier document a figure was read from.
 *
 * Every term this site holds about a supplier — a rebate band, a return window, a restocking fee —
 * is a number somebody will one day argue about with that supplier. A number with no page behind
 * it is not worth having in that argument, and "the software says 75%" is not an answer.
 *
 * So the PDF is stored before it is read, under the supplier's own name, in a category that is
 * neither an invoice nor a general report. It costs one insert and it is the difference between a
 * figure that can be checked and a figure that has to be believed.
 */
export type SupplierDocumentKindStored = "rebate_report" | "return_policy" | "agreement" | "statement";

const CATEGORY: Record<SupplierDocumentKindStored, "supplier_statement" | "supplier_agreement"> = {
  rebate_report: "supplier_statement",
  statement: "supplier_statement",
  return_policy: "supplier_agreement",
  agreement: "supplier_agreement",
};

const WORD: Record<SupplierDocumentKindStored, string> = {
  rebate_report: "rebate breakdown",
  statement: "statement of account",
  return_policy: "returned goods policy",
  agreement: "agreement",
};

export async function storeSupplierDocument(
  buf: Buffer,
  fileName: string,
  opts: {
    supplierId: string;
    supplierName: string;
    kind: SupplierDocumentKindStored;
    user: { id?: string | null; name: string };
    /** The date the document itself is dated, where it is known. */
    effectiveOn?: string | null;
    notes?: string | null;
  },
): Promise<{ id: string; title: string }> {
  const file = new File([new Uint8Array(buf)], fileName, { type: "application/pdf" });
  const stored = await storeFile(file, { allowReportTypes: true });
  const id = newId();
  const title = `${opts.supplierName} ${WORD[opts.kind]}${opts.effectiveOn ? ` — ${opts.effectiveOn}` : ""}`;
  await db.insert(schema.documents).values({
    id,
    category: CATEGORY[opts.kind],
    title,
    fileName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    effectiveOn: opts.effectiveOn ?? null,
    noExpiry: true,
    notes: opts.notes ?? `Kept against ${opts.supplierName} so the terms read from it can be checked against the page.`,
    uploadedBy: opts.user.name,
  });
  return { id, title };
}
