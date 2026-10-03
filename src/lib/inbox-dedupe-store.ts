import "server-only";
import { db, schema } from "@/db";
import { inArray } from "drizzle-orm";
import { inboxRowsToRemove } from "./inbox-dedupe";

/**
 * Collapses the duplicated inbox rows, and says what it did.
 *
 * Runs by itself — see inbox-dedupe.ts for why this one may and the invoice archive clean-up may
 * not. Idempotent: on a tidy inbox it removes nothing and costs one query.
 */
export async function collapseDuplicateInboxRows(): Promise<{ removed: number; arrivals: number; keptWithNoDocument: number; says: string }> {
  const [rows, docs] = await Promise.all([
    db.query.inboxItems.findMany({ columns: { id: true, messageId: true, documentId: true, sweptAt: true } }),
    db.query.documents.findMany({ columns: { id: true } }),
  ]);
  const plan = inboxRowsToRemove(
    rows.map((r) => ({ id: r.id, messageId: r.messageId, documentId: r.documentId ?? null, sweptAt: r.sweptAt ?? null })),
    new Set(docs.map((d) => d.id)),
  );

  for (let i = 0; i < plan.remove.length; i += 100) {
    await db.delete(schema.inboxItems).where(inArray(schema.inboxItems.id, plan.remove.slice(i, i + 100)));
  }

  const says =
    plan.remove.length === 0
      ? `${plan.arrivals} arrivals, one row each.`
      : `${plan.remove.length} duplicate inbox rows removed; ${plan.arrivals} arrivals, one row each now.` +
        (plan.keptWithNoDocument ? ` ${plan.keptWithNoDocument} of them have no document behind them.` : "");
  return { removed: plan.remove.length, arrivals: plan.arrivals, keptWithNoDocument: plan.keptWithNoDocument, says };
}
