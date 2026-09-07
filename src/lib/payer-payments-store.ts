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
    if (read.skipped.length === 0 && range) return { ok: true, banked: 0, alreadyHeld: 0, bankedCents: 0, from: range.from, to: range.to, skipped: [], byPayer: [] };
    return { ok: false, why: `No payment was read. ${read.skipped.slice(0, 3).map((s) => `Row ${s.row}: ${s.why}`).join("; ") || "The file carried no rows."}` };
  }

  const keys = read.payments.map(key);
  const held = new Set(
    (await db.query.cashReceipts.findMany({ where: inArray(schema.cashReceipts.sourceKey, keys), columns: { sourceKey: true } }))
      .map((r) => r.sourceKey)
      .filter((k): k is string => k !== null),
  );

  const fresh = read.payments.filter((p) => !held.has(key(p)));
  if (fresh.length > 0) {
    const values = fresh.map((p) => ({
      id: newId(),
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
      method: p.method,
      remitMatched: p.remitMatched,
      claimMatchCents: p.claimMatchCents,
      noClaimMatchCents: p.noClaimMatchCents,
      adjustmentsCents: p.adjustmentsCents,
      createdBy: by.userName,
    }));
    for (let i = 0; i < values.length; i += 200) await db.insert(schema.cashReceipts).values(values.slice(i, i + 200));
  }

  const byPayer = new Map<string, { payments: number; cents: number }>();
  for (const p of fresh) {
    const cur = byPayer.get(p.payerName) ?? { payments: 0, cents: 0 };
    byPayer.set(p.payerName, { payments: cur.payments + 1, cents: cur.cents + p.amountCents });
  }

  const bankedCents = fresh.reduce((n, p) => n + p.amountCents, 0);
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
    banked: fresh.length,
    alreadyHeld: held.size,
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
