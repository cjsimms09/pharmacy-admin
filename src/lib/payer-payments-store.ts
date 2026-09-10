import { eq } from "drizzle-orm";
import { addCashReceipt } from "./expenses";
import "server-only";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { audit } from "./audit";
import { parsePayerPayments, rangeFromFileName, type PayerPayment } from "./payer-payments";

/**
 * Banking a payer payment report, once.
 *
 * Every payment becomes a cash receipt — the row the cash account already reads — keyed on the
 * payer's own payment number so the same report landing twice adds nothing the second time. That
 * is the whole reason this goes through a key rather than an insert: these reports are date ranges
 * and date ranges get re-run, and a duplicate here is revenue the pharmacy did not earn.
 *
 * The money is banked in the month it was *deposited*, never the month the claim was filled. That
 * is what a cash account means, and it is the difference this file exists to record: a claim from
 * the twenty-eighth that lands on the third is September's money and August's dispensing.
 */
export type PaymentImport = {
  ok: true;
  banked: number;
  alreadyHeld: number;
  bankedCents: number;
  from: string | null;
  to: string | null;
  skipped: { row: number; why: string }[];
  byPayer: { payer: string; payments: number; cents: number }[];
  /** Deposits refused because another feed had already banked the same money, in words. */
  refused: string[];
} | { ok: false; why: string };

const monthOf = (iso: string) => iso.slice(0, 7);
const key = (p: PayerPayment) => `payer-payment|${p.payerName.trim().toLowerCase()}|${p.paymentNumber.trim()}`;

export async function importPayerPayments(
  text: string,
  by: { userId: string | null; userName: string; fileName?: string; documentId?: string | null },
): Promise<PaymentImport> {
  const read = parsePayerPayments(text);
  if (read.payments.length === 0) {
    /*
     * An empty report is a fact, not a failure — a week with no deposits happens — but only where
     * the file was really this report. Where nothing was read at all, say so with the reason for
     * the first few rows rather than reporting a quiet success.
     */
    const range = rangeFromFileName(by.fileName ?? "");
    if (read.skipped.length === 0 && range) return { ok: true, banked: 0, alreadyHeld: 0, bankedCents: 0, from: range.from, to: range.to, skipped: [], byPayer: [], refused: [] as string[] };
    return { ok: false, why: `No payment was read. ${read.skipped.slice(0, 3).map((s) => `Row ${s.row}: ${s.why}`).join("; ") || "The file carried no rows."}` };
  }

  const keys = read.payments.map(key);
  const held = new Set(
    (await db.query.cashReceipts.findMany({ where: inArray(schema.cashReceipts.sourceKey, keys), columns: { sourceKey: true } }))
      .map((r) => r.sourceKey)
      .filter((k): k is string => k !== null),
  );

  const fresh = read.payments.filter((p) => !held.has(key(p)));
  /** Deposits another feed had already banked. Named, never silently dropped and never banked twice. */
  const refused: string[] = [];
  /** The ones that really were banked, which is what every total below must count. */
  const banked: typeof fresh = [];

  /*
   * Through the gate, one at a time, rather than straight into the table.
   *
   * This feed used to insert directly. It is the largest number on the cash account — all twelve of
   * September's receipts, $168,943.43 of $169,210.39 — and it was the one feed that never ran the
   * check whose entire purpose is stopping the same deposit being banked twice.
   *
   * So the protection was one-directional: an 835 arriving after the payment report was caught, and
   * a payment report arriving after the 835 was not. Both orders happen — the report is imported by
   * hand when somebody remembers, the 835s arrive on their own.
   *
   * One call per payment costs two queries where a batch of two hundred cost one. On a month of
   * deposits that is tens of queries and worth it. If a year of history is ever loaded at once and
   * this is slow, the answer is a bulk pre-check, not going back round the gate.
   */
  for (const p of fresh) {
    const r = await addCashReceipt({
      month: monthOf(p.depositedOn),
      // Every one of these is a plan paying a claim; the patient's own money is a different feed.
      kind: "third_party" as const,
      amountCents: p.amountCents,
      payer: p.payerName,
      notes: `${p.method ?? "payment"} ${p.paymentNumber}${p.paidOn && p.paidOn !== p.depositedOn ? `, paid ${p.paidOn}` : ""}`,
      documentId: by.documentId ?? null,
      sourceKey: key(p),
      receivedOn: p.depositedOn,
      reference: p.paymentNumber,
      createdBy: by.userName,
    });
    if (r.duplicate) {
      refused.push(`${p.paymentNumber} from ${p.payerName}: ${r.why}`);
      continue;
    }
    /*
     * The columns this feed knows and the gate does not: how the payer sent it, and how much of it
     * the payer itself could tie to a claim. Written onto the row the gate has just made.
     */
    await db
      .update(schema.cashReceipts)
      .set({ method: p.method, remitMatched: p.remitMatched, claimMatchCents: p.claimMatchCents, noClaimMatchCents: p.noClaimMatchCents, adjustmentsCents: p.adjustmentsCents })
      .where(eq(schema.cashReceipts.id, r.id!));
    banked.push(p);
  }

  const byPayer = new Map<string, { payments: number; cents: number }>();
  for (const p of banked) {
    const cur = byPayer.get(p.payerName) ?? { payments: 0, cents: 0 };
    byPayer.set(p.payerName, { payments: cur.payments + 1, cents: cur.cents + p.amountCents });
  }

  const bankedCents = banked.reduce((n, p) => n + p.amountCents, 0);
  await audit({
    action: "cash.payer_payments_imported",
    userId: by.userId,
    userName: by.userName,
    entity: "cash_receipts",
    entityId: read.from ?? "",
    details: `${fresh.length} payment${fresh.length === 1 ? "" : "s"}, ${(bankedCents / 100).toFixed(2)}, ${read.from} to ${read.to}${held.size ? `; ${held.size} already held` : ""}`,
  });

  return {
    ok: true,
    banked: banked.length,
    alreadyHeld: held.size,
    /*
     * Deposits another feed had already banked, named rather than counted as arrivals.
     *
     * Not the same as `alreadyHeld`, which is this feed meeting its own earlier import. These are
     * the same money reaching the account down two different roads, and the screen has to say so —
     * a payment that vanishes between the file and the total is what makes somebody type it in by
     * hand and bank it a third time.
     */
    refused,
    bankedCents,
    from: read.from,
    to: read.to,
    skipped: read.skipped,
    byPayer: [...byPayer.entries()].map(([payer, v]) => ({ payer, ...v })).sort((a, b) => b.cents - a.cents),
  };
}

/** What has been banked from payment reports, newest first, for the screen that has to show it. */
export async function bankedPayments(limit = 200) {
  const rows = await db.query.cashReceipts.findMany({
    orderBy: (r, { desc }) => [desc(r.receivedOn), desc(r.createdAt)],
    limit,
  });
  return rows.filter((r) => r.sourceKey !== null);
}
