import "server-only";
import { and, eq, gte, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { addCashReceipt } from "./expenses";
import { checkCardBatches, registerReceipt, REGISTER_PAYER, type RegisterDay } from "./register";

export type RegisterCheck = {
  readAt: string;
  days: number;
  banked: number;
  bankedCents: number;
  corrected: number;
  refused: { day: string; why: string }[];
  missingBatches: { day: string; cents: number }[];
  batchesDiffer: { day: string; registerCents: number; batchCents: number }[];
  batchesAgree: number;
};

/**
 * Books each register day's drawer deposit as a patient cash receipt and checks its card takings against the card batch.
 *
 * Idempotent: a day already banked under `register|<day>` is not banked again. The copy PioneerRx is read from is a day
 * old and a drawer can be posted late, so where a day's deposit has since changed the receipt this feed wrote is
 * corrected to it and said — only a receipt carrying this feed's own key, never one typed or banked by another feed.
 */
export async function bankRegisterDays(days: RegisterDay[], by: { userName: string }): Promise<RegisterCheck> {
  const out: RegisterCheck = { readAt: new Date().toISOString(), days: days.length, banked: 0, bankedCents: 0, corrected: 0, refused: [], missingBatches: [], batchesDiffer: [], batchesAgree: 0 };
  const from = days.map((d) => d.day).sort()[0];
  if (!from) return out;

  const held = await db.query.cashReceipts.findMany({ where: like(schema.cashReceipts.sourceKey, "register|%") });
  const byKey = new Map(held.map((r) => [r.sourceKey!, r]));
  for (const d of days) {
    const r = registerReceipt(d);
    if (!r) continue;
    const mine = byKey.get(r.sourceKey);
    if (mine) {
      if (mine.amountCents !== r.amountCents) {
        await db.update(schema.cashReceipts).set({ amountCents: r.amountCents, notes: r.notes }).where(eq(schema.cashReceipts.id, mine.id));
        await audit({ action: "cash.register_corrected", userName: by.userName, entity: "cash_receipt", entityId: mine.id, details: `${d.day}: the drawers' deposit is now $${(r.amountCents / 100).toFixed(2)}, was $${(mine.amountCents / 100).toFixed(2)}` });
        out.corrected++;
      }
      continue;
    }
    const res = await addCashReceipt({ month: d.day.slice(0, 7), kind: "patient", amountCents: r.amountCents, payer: REGISTER_PAYER, notes: r.notes, sourceKey: r.sourceKey, receivedOn: d.day, reference: r.reference, createdBy: by.userName });
    if (res.duplicate) out.refused.push({ day: d.day, why: res.why });
    else {
      out.banked++;
      out.bankedCents += r.amountCents;
    }
  }

  const batches = await db.query.cashReceipts.findMany({ where: and(like(schema.cashReceipts.sourceKey, "card-batch|%"), gte(schema.cashReceipts.receivedOn, from)) });
  const batchByDay = new Map<string, number>();
  for (const b of batches) if (b.receivedOn) batchByDay.set(b.receivedOn, (batchByDay.get(b.receivedOn) ?? 0) + b.amountCents);
  const check = checkCardBatches(days, batchByDay);
  out.missingBatches = check.missing;
  out.batchesDiffer = check.differs;
  out.batchesAgree = check.agree;

  if (out.banked || out.corrected) {
    await audit({ action: "cash.register_read", userName: by.userName, details: `${out.banked} register day(s) banked ($${(out.bankedCents / 100).toFixed(2)}), ${out.corrected} corrected` });
  }
  return out;
}
