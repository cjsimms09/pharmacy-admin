import "server-only";
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Rewrite inbox lines that still say an invoice is held for confirmation after it has been settled.
 *
 * An invoice nobody could classify on arrival is filed with the Schedule II records as a precaution,
 * and its inbox line says so: "Filed with the Schedule II records until you confirm what it
 * carries." That sentence was written once, on arrival, and nothing ever rewrote it. On 22 September
 * 2026, 27 inbox lines said it and not one of those invoices was still waiting. All 27 had their
 * review flag cleared, 25 had been moved to the ordinary drawer, and no invoice anywhere was flagged
 * for review. His inbox was telling him about work that did not exist.
 *
 * Work that succeeded, and a record of it that says otherwise: the fourth time this shape has turned
 * up in the inbox alone. So the line is rewritten from what the invoice is now, and only when the
 * invoice is no longer waiting. One still flagged keeps its sentence, because that sentence is true.
 */
const LABEL: Record<string, string> = {
  schedule_2: "Schedule II",
  schedule_3_5: "Schedule III-V",
  none: "No controlled substances",
};

export async function refreshHeldInboxLines(): Promise<{ rewritten: number }> {
  const stale = await db.query.inboxItems.findMany({
    where: and(like(schema.inboxItems.reason, "%until somebody confirms%"), eq(schema.inboxItems.routedAs, "invoice")),
    columns: { id: true, documentId: true },
  });
  let rewritten = 0;
  for (const item of stale) {
    if (!item.documentId) continue;
    const inv = await db.query.supplierInvoices.findFirst({
      where: eq(schema.supplierInvoices.documentId, item.documentId),
      columns: { schedule: true, needsReview: true },
    });
    if (!inv || inv.needsReview) continue;
    const where = LABEL[inv.schedule ?? ""];
    if (!where) continue;
    await db
      .update(schema.inboxItems)
      .set({
        routeResult: `Filed under ${where}.`,
        reason: `Supplier invoice, filed under ${where}, kept apart from every other record. Held with the Schedule II records on arrival until its lines could be read; settled since.`,
      })
      .where(eq(schema.inboxItems.id, item.id));
    rewritten++;
  }
  return { rewritten };
}
