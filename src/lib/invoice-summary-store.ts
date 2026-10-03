import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { audit } from "./audit";
import { parseInvoiceSummary } from "./invoice-summary";

/**
 * Filing what an Invoice Summary says was spent, until the invoices themselves arrive.
 *
 * Each line becomes an invoice record carrying its number, its date and its total, and nothing
 * else — because the report carries nothing else. No line items, so no cost per bottle, no
 * controlled-substance lines, no rebate flags. What it does carry is the money, which is the one
 * thing the cash account cannot do without: without it, a month whose invoices were never emailed
 * shows nothing bought at the largest supplier and reads as a very profitable month.
 *
 * The row says of itself that it came from a summary, and that is what makes it safe. When the
 * real invoice arrives — by email, as they now do — it finds the placeholder and takes its place
 * rather than being refused as a duplicate. That is the one behaviour that has to be right here: a
 * placeholder that survived alongside the real invoice would count the same purchase twice, and
 * double-counted purchases are invisible in every figure they touch.
 */
export const FROM_SUMMARY = "From the Invoice Summary by Supplier";

export type SummaryImport =
  | { ok: true; supplier: string[]; filed: number; alreadyHeld: number; totalCents: number; from: string | null; to: string | null; skipped: number }
  | { ok: false; why: string };

export async function importInvoiceSummary(
  text: string,
  by: { userId: string | null; userName: string; documentId: string },
): Promise<SummaryImport> {
  const read = parseInvoiceSummary(text);
  if (read.disagreement) return { ok: false, why: read.disagreement };
  if (read.invoices.length === 0) {
    return { ok: false, why: `No invoice was read${read.skipped.length ? `: ${read.skipped.slice(0, 3).map((s) => `line ${s.line}, ${s.why}`).join("; ")}` : ". The report carried no invoice rows."}` };
  }

  let filed = 0;
  let alreadyHeld = 0;
  for (const v of read.invoices) {
    /*
     * The supplier's own number and date, which is what makes two records the same bill. The same
     * report re-run for an overlapping range files nothing new, and a real invoice already filed
     * is never replaced by a summary line that knows less than it does.
     */
    const already = await db.query.supplierInvoices.findFirst({
      where: and(
        eq(schema.supplierInvoices.invoiceNumber, v.invoiceNumber),
        eq(schema.supplierInvoices.invoiceDate, v.invoiceDate),
        eq(schema.supplierInvoices.supplier, v.supplier),
      ),
    });
    if (already) {
      alreadyHeld++;
      continue;
    }
    await db.insert(schema.supplierInvoices).values({
      id: newId(),
      documentId: by.documentId,
      supplier: v.supplier,
      invoiceNumber: v.invoiceNumber,
      invoiceDate: v.invoiceDate,
      /*
       * The schedule is unknown and is said to be, not assumed to be "none".
       *
       * A summary line cannot say whether the invoice carried controlled substances, and recording
       * it as carrying none would be a controlled-substance record asserting something nobody
       * checked. The real invoice settles it when it arrives.
       */
      schedule: "unknown",
      basis: `${FROM_SUMMARY} of ${read.from ?? "?"} to ${read.to ?? "?"}. The total only; the invoice itself has not been filed.`,
      controlledItems: "",
      itemsText: "",
      totalCents: v.totalCents,
      // No lines, and none to read: a summary has none, which is different from an unread invoice.
      linesRead: 0,
      linesUnread: 0,
      needsReview: false,
      receivedFrom: null,
    });
    filed++;
  }

  await audit({
    action: "invoice.summary_imported",
    userId: by.userId,
    userName: by.userName,
    entity: "supplier_invoices",
    entityId: read.from ?? "",
    details: `${read.suppliers.join(", ")}: ${filed} filed, ${alreadyHeld} already held, $${(read.totalCents / 100).toFixed(2)} across ${read.from} to ${read.to}`,
  });

  return {
    ok: true,
    supplier: read.suppliers,
    filed,
    alreadyHeld,
    totalCents: read.totalCents,
    from: read.from,
    to: read.to,
    skipped: read.skipped.length,
  };
}
