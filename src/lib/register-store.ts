import "server-only";
import { and, eq, gte, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { addCashReceipt } from "./expenses";
import { checkCardBatches, registerCardReceipt, registerReceipt, REGISTER_CARD_PAYER, REGISTER_PAYER, type RegisterDay } from "./register";

export type RegisterCheck = {
  readAt: string;
  days: number;
  banked: number;
  bankedCents: number;
  corrected: number;
  refused: { day: string; why: string }[];
  /** Days the register took cards and no batch was ever forwarded. Banked from the register; kept so the site can say which days rest on it. */
  missingBatches: { day: string; cents: number }[];
  batchesDiffer: { day: string; registerCents: number; batchCents: number }[];
  batchesAgree: number;
  cardsBanked: number;
  cardsBankedCents: number;
};

/**
 * Books each register day's drawer deposit as a patient cash receipt and checks its card takings against the card batch.
 *
 * Idempotent: a day already banked under `register|<day>` is not banked again. The copy PioneerRx is read from is a day
 * old and a drawer can be posted late, so where a day's deposit has since changed the receipt this feed wrote is
 * corrected to it and said — only a receipt carrying this feed's own key, never one typed or banked by another feed.
 */
export async function bankRegisterDays(days: RegisterDay[], by: { userName: string }): Promise<RegisterCheck> {
  const out: RegisterCheck = { readAt: new Date().toISOString(), days: days.length, banked: 0, bankedCents: 0, corrected: 0, refused: [], missingBatches: [], batchesDiffer: [], batchesAgree: 0, cardsBanked: 0, cardsBankedCents: 0 };
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

  /*
   * The card money on days whose batch was never forwarded.
   *
   * Asking for those emails was the whole of the site's answer until now, and the answer to the ask was no: "stop
   * asking, not sending" (16 September 2026). An alert that repeats a request already refused is how a person learns
   * to stop reading alerts, and the money — $14,984.24 over four September days — stayed out of the cash account
   * either way. So the register banks it, keyed apart from the drawer deposit, and the batch supersedes it if one
   * ever arrives (`bankCardBatch`). Same correction rule as the deposit: this feed's own receipt, never another's.
   */
  const heldCards = await db.query.cashReceipts.findMany({ where: like(schema.cashReceipts.sourceKey, "register-card|%") });
  const cardByKey = new Map(heldCards.map((r) => [r.sourceKey!, r]));
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const m of check.missing) {
    const d = byDay.get(m.day);
    const r = d ? registerCardReceipt(d) : null;
    if (!r) continue;
    const mine = cardByKey.get(r.sourceKey);
    if (mine) {
      if (mine.amountCents !== r.amountCents) {
        await db.update(schema.cashReceipts).set({ amountCents: r.amountCents, notes: r.notes, reference: r.reference }).where(eq(schema.cashReceipts.id, mine.id));
        await audit({ action: "cash.register_card_corrected", userName: by.userName, entity: "cash_receipt", entityId: mine.id, details: `${m.day}: the register's card takings are now $${(r.amountCents / 100).toFixed(2)}, were $${(mine.amountCents / 100).toFixed(2)}` });
        out.corrected++;
      }
      continue;
    }
    const res = await addCashReceipt({ month: m.day.slice(0, 7), kind: "patient", amountCents: r.amountCents, payer: REGISTER_CARD_PAYER, notes: r.notes, sourceKey: r.sourceKey, receivedOn: m.day, reference: r.reference, createdBy: by.userName });
    if (res.duplicate) out.refused.push({ day: m.day, why: `card takings: ${res.why}` });
    else {
      out.cardsBanked++;
      out.cardsBankedCents += r.amountCents;
    }
  }

  if (out.banked || out.corrected || out.cardsBanked) {
    await audit({
      action: "cash.register_read",
      userName: by.userName,
      details:
        `${out.banked} register day(s) banked ($${(out.bankedCents / 100).toFixed(2)}), ${out.corrected} corrected` +
        (out.cardsBanked ? `; ${out.cardsBanked} day(s) of card takings banked from the register with no batch on file ($${(out.cardsBankedCents / 100).toFixed(2)})` : ""),
    });
  }
  return out;
}
