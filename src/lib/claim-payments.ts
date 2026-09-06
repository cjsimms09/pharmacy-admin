import "server-only";
import { db, schema } from "@/db";
import { eq, isNull } from "drizzle-orm";
import { newId } from "./crypto";
import type { LaterPayment } from "./fills";

/**
 * Money that reaches a claim after it was adjudicated.
 *
 * A claim's revenue is not settled on the day it is transmitted. A Medicare Transaction Facilitator
 * payment arrives weeks later. So does a DIR reconciliation, a copay card posted after the fact, or
 * a secondary that adjudicated late. Held only as what the daily report said on the day, every one
 * of those is money the pharmacy received and this system never counted — and a fill sits on the
 * "dispensed at a loss" list because of a payment that has since arrived.
 *
 * Kept as rows of its own rather than added into the claim, because what was paid on the day has to
 * stay distinguishable from what arrived afterwards. That distinction is the whole point when a
 * payer is being judged: the plan paid what the plan paid, and a facilitator payment on top of it
 * is not the plan's money and must not flatter it.
 *
 * Matched on the fill — prescription, fill number, date and NDC — rather than on a claim id,
 * because a remittance names a prescription and this system's ids mean nothing to anybody outside
 * it. It is also the only join that holds where the fill went to two payers and so has two claim
 * rows.
 */

export type RecordPayment = {
  rxNumber: string;
  fillNumber?: number | null;
  dateFilled?: string | null;
  ndc11?: string | null;
  source: "mtf" | "dir" | "copay_card" | "secondary" | "manual";
  payer?: string | null;
  amountCents: number;
  receivedOn?: string | null;
  reference?: string | null;
  notes?: string | null;
};

/**
 * Records a payment, attaching it to the claim it belongs to where one can be found.
 *
 * The claim id is a convenience, not the key: a payment for a prescription this system has not
 * loaded yet is still recorded, and picks up its claim when the claim arrives. Losing money because
 * the remittance beat the daily report would be an ordering nobody outside this code knows about.
 */
export async function recordClaimPayment(p: RecordPayment, user: { name: string }): Promise<{ id: string; matched: boolean }> {
  const rx = p.rxNumber.trim();
  if (!rx) throw new Error("A payment has to name the prescription it is for.");
  if (!Number.isFinite(p.amountCents) || p.amountCents === 0) throw new Error("Give the amount received.");

  const claim = await findClaim(rx, p.fillNumber ?? null, p.dateFilled ?? null, p.ndc11 ?? null);
  const id = newId();
  await db.insert(schema.claimPayments).values({
    id,
    claimId: claim?.id ?? null,
    rxNumber: rx,
    fillNumber: p.fillNumber ?? claim?.fillNumber ?? null,
    dateFilled: p.dateFilled ?? claim?.dateFilled ?? null,
    ndc11: p.ndc11 ?? claim?.ndc11 ?? null,
    source: p.source,
    payer: p.payer ?? null,
    amountCents: Math.round(p.amountCents),
    receivedOn: p.receivedOn ?? null,
    reference: p.reference ?? null,
    notes: p.notes ?? null,
    recordedBy: user.name,
  });
  return { id, matched: claim !== null };
}

async function findClaim(rxNumber: string, fillNumber: number | null, dateFilled: string | null, ndc11: string | null) {
  const rows = await db.query.claims.findMany({
    where: eq(schema.claims.rxNumber, rxNumber),
    columns: { id: true, fillNumber: true, dateFilled: true, ndc11: true },
  });
  if (rows.length === 0) return null;
  // The most specific match wins; a remittance that names only the prescription still lands.
  const fits = rows.filter(
    (r) =>
      (fillNumber === null || r.fillNumber === fillNumber) &&
      (dateFilled === null || r.dateFilled === dateFilled) &&
      (ndc11 === null || r.ndc11 === ndc11),
  );
  return fits[0] ?? null;
}

/** Every later payment, in the shape the fill grouping takes. */
export async function laterPayments(): Promise<LaterPayment[]> {
  const rows = await db.query.claimPayments.findMany();
  return rows.map((r) => ({
    rxNumber: r.rxNumber,
    fillNumber: r.fillNumber,
    dateFilled: r.dateFilled,
    ndc11: r.ndc11,
    source: r.source,
    payer: r.payer,
    amountCents: r.amountCents,
  }));
}

/**
 * Attaches payments recorded before their claim arrived.
 *
 * Run after a claims load. Cheap, and it means a remittance that beat the daily report is not money
 * quietly sitting against nothing.
 */
export async function matchOrphanPayments(): Promise<{ matched: number }> {
  const orphans = await db.query.claimPayments.findMany({ where: isNull(schema.claimPayments.claimId) });
  let matched = 0;
  for (const p of orphans) {
    const claim = await findClaim(p.rxNumber, p.fillNumber, p.dateFilled, p.ndc11);
    if (!claim) continue;
    await db.update(schema.claimPayments).set({ claimId: claim.id }).where(eq(schema.claimPayments.id, p.id));
    matched++;
  }
  return { matched };
}

/** What has arrived after the day, by where it came from, for a page that has to show it. */
export async function laterPaymentSummary(): Promise<{ source: string; payments: number; amountCents: number; unmatched: number }[]> {
  const rows = await db.query.claimPayments.findMany();
  const by = new Map<string, { source: string; payments: number; amountCents: number; unmatched: number }>();
  for (const r of rows) {
    const e = by.get(r.source) ?? { source: r.source, payments: 0, amountCents: 0, unmatched: 0 };
    e.payments++;
    e.amountCents += r.amountCents;
    if (!r.claimId) e.unmatched++;
    by.set(r.source, e);
  }
  return [...by.values()].sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Recovers the patient's residual for claims loaded before it was being kept.
 *
 * The daily report's "Total" column was parsed and thrown away, so every claim already held has a
 * patient payment of nothing — which on a deductible fill is the whole of the money. The raw row is
 * stored against each claim, so it can be recovered without asking for the files again.
 */
export async function backfillPatientTotals(): Promise<{ read: number; filled: number }> {
  const rows = await db.query.claims.findMany({ columns: { id: true, rawJson: true, patientTotalCents: true } });
  let filled = 0;
  let read = 0;
  for (const r of rows) {
    if (r.patientTotalCents !== null || !r.rawJson) continue;
    read++;
    try {
      const raw = JSON.parse(r.rawJson) as Record<string, string>;
      const printed = raw["Total"] ?? raw["Patient Total"] ?? raw["patientTotal"];
      if (printed === undefined) continue;
      const n = Number(String(printed).replace(/[$,()\s]/g, ""));
      if (!Number.isFinite(n)) continue;
      const negative = /^\(.*\)$/.test(String(printed).trim());
      await db
        .update(schema.claims)
        .set({ patientTotalCents: Math.round(n * 100) * (negative ? -1 : 1) })
        .where(eq(schema.claims.id, r.id));
      filled++;
    } catch {
      // A row whose raw text cannot be read is left as it was rather than guessed at.
    }
  }
  return { read, filled };
}
