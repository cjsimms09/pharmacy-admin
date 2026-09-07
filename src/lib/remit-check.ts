/**
 * Remits against claims: what the plan's own remittance paid on a fill, against what the claim
 * was adjudicated for.
 *
 * The third balance of the engine. A claim carries the amount the plan said it would pay at
 * adjudication; the 835 says what it actually paid. The two are the same money and must agree
 * to the cent. Where they do not, the plan short-paid (an appeal, or a takeback to chase), or
 * over-paid (money that will be clawed back and must not be spent). Only a plan's own payments
 * (source "plan") enter into this: the facilitator's and a card's money is on top of the
 * adjudicated remit, not a settlement of it. Pure.
 */

export type RemitFill = {
  key: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  itemName: string | null;
  /** Adjudicated across every payer leg. Used only where `payers` is empty. */
  remitCents: number;
  /**
   * One leg per payer that adjudicated the fill, primary first, each with what it said it would
   * pay. A fill coordinated across two plans is two legs, and each plan's 835 settles its own.
   */
  payers?: { name: string | null; remitCents: number }[];
  laterPayments: { source: string; payer: string | null; amountCents: number }[];
};

export type RemitLine = { key: string; rxNumber: string; fillNumber: number | null; dateFilled: string; itemName: string | null; payer: string | null; adjudicatedCents: number; paidCents: number; differenceCents: number };

export type RemitCheck = {
  /** Payer legs with a plan's payment on them. A coordinated fill is two legs. */
  checked: number;
  agrees: number;
  short: RemitLine[];
  shortCents: number;
  over: RemitLine[];
  overCents: number;
  /** Legs adjudicated to a plan with no plan payment posted yet: the receivable, by leg. */
  awaiting: number;
  awaitingCents: number;
};

/** Below this the difference is rounding, not a finding. */
export const REMIT_TOLERANCE_CENTS = 2;

const fold = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Whether a payment's payer names a leg's: either way round, so "CVS Caremark" meets "Caremark". */
const names = (a: string | null, b: string | null) => {
  const x = fold(a);
  const y = fold(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
};

/**
 * Each plan's payment against the leg it settles.
 *
 * A fill coordinated across two plans is adjudicated twice — the primary for most of it, the
 * secondary for the rest — and each plan sends its own 835. Compared as one total, the primary's
 * remittance arriving first reads as the fill short by the whole of the secondary's share, which
 * is about one fill in twenty raising an appeal for money that was never short. So the comparison
 * is per leg: a payment goes to the leg whose payer it names; one that names nobody goes to the
 * first leg still unpaid, because remittances arrive in the order the claim was adjudicated; and a
 * leg with no payment against it is awaiting, not short.
 */
function settle(f: RemitFill, plan: RemitFill["laterPayments"]): { leg: { name: string | null; remitCents: number }; paid: number; payments: number }[] {
  const legs = (f.payers ?? []).length > 0 ? (f.payers as { name: string | null; remitCents: number }[]) : [{ name: plan[0]?.payer ?? null, remitCents: f.remitCents }];
  const rows = legs.map((leg) => ({ leg, paid: 0, payments: 0 }));
  const unplaced: RemitFill["laterPayments"] = [];
  for (const p of plan) {
    const named = rows.find((r) => names(p.payer, r.leg.name));
    if (named) {
      named.paid += p.amountCents;
      named.payments++;
    } else unplaced.push(p);
  }
  for (const p of unplaced) {
    const target = rows.find((r) => r.payments === 0) ?? rows[0];
    target.paid += p.amountCents;
    target.payments++;
  }
  return rows;
}

export function remitCheck(fills: RemitFill[]): RemitCheck {
  const out: RemitCheck = { checked: 0, agrees: 0, short: [], shortCents: 0, over: [], overCents: 0, awaiting: 0, awaitingCents: 0 };
  for (const f of fills) {
    const plan = f.laterPayments.filter((p) => p.source === "plan");
    for (const { leg, paid, payments } of settle(f, plan)) {
      if (payments === 0) {
        if (leg.remitCents > 0) {
          out.awaiting++;
          out.awaitingCents += leg.remitCents;
        }
        continue;
      }
      out.checked++;
      const differenceCents = paid - leg.remitCents;
      const line: RemitLine = { key: f.key, rxNumber: f.rxNumber, fillNumber: f.fillNumber, dateFilled: f.dateFilled, itemName: f.itemName, payer: leg.name, adjudicatedCents: leg.remitCents, paidCents: paid, differenceCents };
      if (Math.abs(differenceCents) <= REMIT_TOLERANCE_CENTS) out.agrees++;
      else if (differenceCents < 0) {
        out.short.push(line);
        out.shortCents += -differenceCents;
      } else {
        out.over.push(line);
        out.overCents += differenceCents;
      }
    }
  }
  out.short.sort((a, b) => a.differenceCents - b.differenceCents);
  out.over.sort((a, b) => b.differenceCents - a.differenceCents);
  return out;
}
