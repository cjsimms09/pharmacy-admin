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
  remitCents: number;
  laterPayments: { source: string; payer: string | null; amountCents: number }[];
};

export type RemitLine = { key: string; rxNumber: string; fillNumber: number | null; dateFilled: string; itemName: string | null; payer: string | null; adjudicatedCents: number; paidCents: number; differenceCents: number };

export type RemitCheck = {
  /** Fills with a plan's payment on them. */
  checked: number;
  agrees: number;
  short: RemitLine[];
  shortCents: number;
  over: RemitLine[];
  overCents: number;
  /** Fills adjudicated to a plan with no plan payment posted yet: the receivable, by fill. */
  awaiting: number;
  awaitingCents: number;
};

/** Below this the difference is rounding, not a finding. */
export const REMIT_TOLERANCE_CENTS = 2;

export function remitCheck(fills: RemitFill[]): RemitCheck {
  const out: RemitCheck = { checked: 0, agrees: 0, short: [], shortCents: 0, over: [], overCents: 0, awaiting: 0, awaitingCents: 0 };
  for (const f of fills) {
    const plan = f.laterPayments.filter((p) => p.source === "plan");
    if (plan.length === 0) {
      if (f.remitCents > 0) {
        out.awaiting++;
        out.awaitingCents += f.remitCents;
      }
      continue;
    }
    out.checked++;
    const paidCents = plan.reduce((n, p) => n + p.amountCents, 0);
    const differenceCents = paidCents - f.remitCents;
    const line: RemitLine = { key: f.key, rxNumber: f.rxNumber, fillNumber: f.fillNumber, dateFilled: f.dateFilled, itemName: f.itemName, payer: plan[0].payer, adjudicatedCents: f.remitCents, paidCents, differenceCents };
    if (Math.abs(differenceCents) <= REMIT_TOLERANCE_CENTS) out.agrees++;
    else if (differenceCents < 0) {
      out.short.push(line);
      out.shortCents += -differenceCents;
    } else {
      out.over.push(line);
      out.overCents += differenceCents;
    }
  }
  out.short.sort((a, b) => a.differenceCents - b.differenceCents);
  out.over.sort((a, b) => b.differenceCents - a.differenceCents);
  return out;
}
