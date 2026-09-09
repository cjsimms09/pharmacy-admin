import "server-only";
import { db } from "@/db";

/**
 * Money a plan paid for a fill the pharmacy reversed, and whether the plan has taken it back yet.
 *
 * The owner, 9 September: "we need to make sure we know how to handle those situations though.. how
 * do we handle that properly.. is it a credit? how does it get fixed? im sure insurance will take
 * that back?" He is right that they take it back, and that is exactly why this exists.
 *
 * What happens in practice. A reversal tells the plan the dispensing did not stand, but the money
 * for it has usually already moved, so the plan recovers it on a later remittance — as a claim line
 * with status 22, a reversal of a previous payment, carrying a negative amount, or as a
 * provider-level adjustment that nets the amount off the next cheque. Days or weeks pass between
 * the two. In that gap the pharmacy is holding money it is going to give back.
 *
 * So it is not revenue and it is not a credit the pharmacy issues. It is cash received against a
 * liability. The site records it as money in, attaches it to no claim, and counts it here until an
 * offsetting negative arrives for the same prescription and fill. What this page is for is the
 * other case: a payment that is never recovered. That is the plan's money, and a pharmacy that
 * cannot see it will keep it without ever deciding to.
 */

export type ReversedFillPayment = {
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string | null;
  payer: string | null;
  receivedOn: string | null;
  /** What came in on the fill, less anything taken back. Zero means the plan has recovered it. */
  netCents: number;
  paidCents: number;
  takenBackCents: number;
  /** Days since the money arrived, so an old one can be chased rather than merely listed. */
  daysHeld: number | null;
  reference: string | null;
};

/**
 * Payments on fills whose only claim was reversed, netted against any recovery.
 *
 * Grouped by prescription and fill because that is what a plan recovers against: the takeback names
 * the same prescription, and its negative amount is what closes this out. A fill whose payments net
 * to zero is settled and is not returned.
 */
export async function paymentsOnReversedFills(today = new Date()): Promise<ReversedFillPayment[]> {
  const [payments, claims] = await Promise.all([
    db.query.claimPayments.findMany(),
    db.query.claims.findMany({ columns: { rxNumber: true, fillNumber: true, status: true } }),
  ]);

  /*
   * A fill counts as reversed when the pharmacy holds no paid claim for it.
   *
   * Keyed on prescription and fill rather than on the claim id: a fill billed to a primary and a
   * secondary has two claim rows, and it is only reversed if neither of them stands.
   */
  const paidFills = new Set<string>();
  const knownFills = new Set<string>();
  for (const c of claims) {
    const key = `${c.rxNumber}|${c.fillNumber ?? ""}`;
    knownFills.add(key);
    if (c.status === "paid") paidFills.add(key);
  }

  const byFill = new Map<string, ReversedFillPayment>();
  for (const p of payments) {
    const key = `${p.rxNumber}|${p.fillNumber ?? ""}`;
    // Only fills this pharmacy actually holds a claim for. A payment for a prescription the site has
    // never seen is simply waiting for its claim, which is a different thing and is chased elsewhere.
    if (!knownFills.has(key) || paidFills.has(key)) continue;
    const held = byFill.get(key) ?? {
      rxNumber: p.rxNumber,
      fillNumber: p.fillNumber,
      dateFilled: p.dateFilled,
      payer: p.payer,
      receivedOn: p.receivedOn,
      netCents: 0,
      paidCents: 0,
      takenBackCents: 0,
      daysHeld: null,
      reference: p.reference,
    };
    held.netCents += p.amountCents;
    if (p.amountCents >= 0) held.paidCents += p.amountCents;
    else held.takenBackCents += -p.amountCents;
    // The earliest arrival is the one the clock runs from.
    if (p.receivedOn && (!held.receivedOn || p.receivedOn < held.receivedOn)) held.receivedOn = p.receivedOn;
    byFill.set(key, held);
  }

  const out: ReversedFillPayment[] = [];
  for (const r of byFill.values()) {
    if (r.netCents === 0) continue; // recovered in full; nothing to hold or chase
    r.daysHeld = r.receivedOn ? Math.floor((today.getTime() - new Date(`${r.receivedOn}T00:00:00Z`).getTime()) / 86_400_000) : null;
    out.push(r);
  }
  // Oldest and largest first: the two things that decide which one to ask about.
  return out.sort((a, b) => (b.daysHeld ?? 0) - (a.daysHeld ?? 0) || Math.abs(b.netCents) - Math.abs(a.netCents));
}

/** One line for the money pages: what is being held, and how much of it has gone unrecovered a while. */
export async function reversedFillMoney(today = new Date()): Promise<{ fills: number; heldCents: number; over30: number; over30Cents: number }> {
  const rows = await paymentsOnReversedFills(today);
  const over = rows.filter((r) => (r.daysHeld ?? 0) > 30);
  return {
    fills: rows.length,
    heldCents: rows.reduce((n, r) => n + r.netCents, 0),
    over30: over.length,
    over30Cents: over.reduce((n, r) => n + r.netCents, 0),
  };
}
