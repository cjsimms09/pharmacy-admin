/**
 * One fill, however many payers priced it.
 *
 * The daily report has a row per *transmission*, not per dispensing. A prescription billed to a
 * primary plan and then to a secondary appears twice, under two BINs, with the same prescription
 * number, fill number, date and NDC — and both rows carry the same acquisition cost, because it is
 * the same bottle.
 *
 * Counted as two claims, that fill is a disaster in every direction. Its cost is counted twice, so
 * the margin is understated by the whole acquisition price. Its patient responsibility is counted
 * twice, because the primary's copay is exactly what the secondary is then billed. And the primary
 * row on its own — a plan paying eight dollars towards a six-hundred-dollar drug — reads as a
 * catastrophic loss, when in fact the secondary paid the rest.
 *
 * That is what put a real day's claims $459 in the red on this pharmacy's first live file.
 *
 * ── The arithmetic that fixes it ──
 *
 * Revenue is the sum of what every payer remitted, plus what the patient actually paid — and the
 * patient pays once. In a coordinated chain each payer reduces what is left owing, so the residual
 * the patient hands over is the *smallest* copay in the chain, not the sum of them. The primary's
 * copay is not money; it is the amount handed on to the secondary.
 *
 * Cost is the acquisition price, taken once. Quantity is taken once. Neither is doubled by a claim
 * being transmitted twice.
 *
 * ── What is deliberately left out ──
 *
 * A reversal that matches no claim this site holds is not a loss. It reverses a dispensing from
 * before the feed began, whose revenue was never counted here, so subtracting it invents a loss out
 * of a correction to a figure the site never had. On the first live file six of them together came
 * to more than twelve hundred dollars against a single BIN.
 *
 * Pure, so the arithmetic can be checked against a real day's report by hand.
 */

export type ClaimRow = {
  id: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string | null;
  itemName: string | null;
  bin: string | null;
  /** The plan's group number, which with the BIN is what identifies the actual plan. */
  groupNumber?: string | null;
  pbmName: string | null;
  payerLabel: string | null;
  quantityThousandths: number | null;
  remitCents: number | null;
  copayCents: number | null;
  /**
   * What the patient was left owing after this adjudication — the report's "Total", not its "Copay".
   *
   * The two differ exactly where it costs money. Where a plan pays nothing and applies the fill to
   * a deductible, the copay column reads zero while the patient is left owing the whole price; take
   * the copay as the patient's payment and the entire sum vanishes. On one real fill that was
   * $115.57 of a $161.83 prescription, and it turned $33.14 of margin into an $82.43 loss.
   */
  patientTotalCents?: number | null;
  acquisitionCents: number | null;
  /** The gross profit the report itself printed for this row. The check on our own arithmetic. */
  grossProfitCents?: number | null;
  status: string;
  /** True where this is a reversal that matched no claim held. */
  unmatchedReversal?: boolean;
};

export type FillPayer = {
  bin: string | null;
  /** BIN and group together identify the plan; the BIN alone often identifies only the processor. */
  groupNumber: string | null;
  name: string | null;
  remitCents: number;
  /** What the patient was left owing after this payer adjudicated. */
  copayCents: number;
};

export type Fill = {
  key: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string | null;
  itemName: string | null;
  /** Every payer that priced this fill, in the order the rows arrived. */
  payers: FillPayer[];
  /** True where more than one plan paid: the case this exists for. */
  coordinated: boolean;
  quantityThousandths: number | null;
  /** What every payer remitted, added. */
  remitCents: number;
  /** What the patient actually handed over: the residual after the last plan. */
  patientPaidCents: number;
  /**
   * Money that reached this fill after it was adjudicated: an MTF payment, a DIR reconciliation, a
   * copay card posted late. Real revenue, and not the plan's — so it is added and kept nameable.
   */
  laterPaymentsCents: number;
  laterPayments: { source: string; payer: string | null; amountCents: number }[];
  /** Remit, plus what the patient paid, plus anything that arrived afterwards. */
  revenueCents: number;
  /**
   * True where the payers disagree about what the patient owes and the order cannot be settled.
   *
   * The report is grouped by payer, not by time, so where two plans priced one fill there is
   * nothing in it that says which came first — and the patient's share is whatever the *last* plan
   * left owing. The smallest is taken, which is right whenever each plan reduces what is left, and
   * it is flagged rather than asserted. The figure at stake is a copay; the error this whole
   * grouping exists to fix is an acquisition cost counted twice, which is far larger.
   */
  patientShareUncertain: boolean;
  /** What the bottle cost, taken once. Null where the report carried none. */
  acquisitionCents: number | null;
  /** Revenue less acquisition, where acquisition is known. */
  marginCents: number | null;
  /**
   * What the report itself said this fill made, added across its rows.
   *
   * The check that makes the rest of this trustworthy. Column positions in the daily report are
   * worked out by counting, and a report whose columns shift by one produces figures that are each
   * individually plausible and collectively wrong — a dispensing fee read as a patient total, a tax
   * read as a quantity. Nothing inside our own arithmetic can notice that. The report's own gross
   * profit can: it is computed by PioneerRx from the same row, so if our margin and theirs disagree
   * then one of the columns is not what this reader thinks it is.
   */
  reportedMarginCents: number | null;
  /** False where our arithmetic and the report's disagree by more than a rounding cent. */
  agreesWithReport: boolean | null;
};

/** The same dispensing, whichever plan was billed. */
export function fillKey(c: { rxNumber: string; fillNumber: number | null; dateFilled: string; ndc11: string | null }): string {
  return [c.rxNumber.trim(), c.fillNumber ?? "", c.dateFilled, c.ndc11 ?? ""].join("|");
}

export type LaterPayment = {
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string | null;
  ndc11: string | null;
  source: string;
  payer: string | null;
  amountCents: number;
};

export function groupIntoFills(claims: ClaimRow[], later: LaterPayment[] = []): Fill[] {
  const by = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    // A reversed row is not revenue, and a reversal matching nothing held is not a loss either.
    if (c.status === "reversed") continue;
    if (c.unmatchedReversal) continue;
    const k = fillKey(c);
    by.set(k, [...(by.get(k) ?? []), c]);
  }

  const out: Fill[] = [];
  for (const [key, rows] of by) {
    const payers: FillPayer[] = rows.map((r) => ({
      bin: r.bin,
      groupNumber: r.groupNumber ?? null,
      name: r.pbmName ?? r.payerLabel,
      remitCents: r.remitCents ?? 0,
      /*
       * The patient's residual, from the column that actually carries it.
       *
       * "Total" is what the patient was left owing after this adjudication; "Copay" is the copay the
       * plan assessed, which is zero on a deductible fill where the patient in fact owes everything.
       * Falling back to the copay only where no total was read keeps older rows working.
       */
      copayCents: r.patientTotalCents ?? r.copayCents ?? 0,
    }));
    const remitCents = payers.reduce((n, p) => n + p.remitCents, 0);
    /*
     * The patient pays once.
     *
     * Each plan in a coordinated chain reduces what is left owing, so the residual actually handed
     * over is the smallest copay on the chain. Summing them counts the primary's copay — which is
     * simply the amount passed to the secondary — as money the pharmacy received.
     */
    const copays = payers.map((p) => p.copayCents);
    const patientPaidCents = payers.length === 1 ? copays[0] : Math.min(...copays);
    const patientShareUncertain = payers.length > 1 && new Set(copays).size > 1 && copays.every((c) => c > 0);

    // The same bottle, priced once, whatever it was transmitted against.
    const costs = rows.map((r) => r.acquisitionCents).filter((x): x is number => x !== null && x !== undefined);
    const acquisitionCents = costs.length ? Math.max(...costs) : null;
    const quantities = rows.map((r) => r.quantityThousandths).filter((x): x is number => x !== null && x !== undefined);
    const quantityThousandths = quantities.length ? Math.max(...quantities) : null;

    /*
     * What arrived after the day, matched on the fill rather than on the claim row.
     *
     * A facilitator payment names a prescription and a date, not the claim id this system happens
     * to have given it, and it may arrive for a fill that went to two payers. Matching on the fill
     * is the only join that holds.
     */
    const mine = later.filter((p) => fillKey({ rxNumber: p.rxNumber, fillNumber: p.fillNumber, dateFilled: p.dateFilled ?? "", ndc11: p.ndc11 }) === key);
    const laterPaymentsCents = mine.reduce((n, p) => n + p.amountCents, 0);

    const revenueCents = remitCents + patientPaidCents + laterPaymentsCents;

    /*
     * The report's own answer, for comparison — but only where it is comparable.
     *
     * A payment that arrived weeks later cannot be in a figure printed on the day, so a fill
     * carrying one is not evidence of anything and is left unchecked rather than reported as a
     * disagreement.
     */
    const reported = rows.map((r) => r.grossProfitCents).filter((x): x is number => x !== null && x !== undefined);
    const reportedMarginCents = reported.length === rows.length && rows.length > 0 ? reported.reduce((n, x) => n + x, 0) : null;

    const first = rows[0];
    out.push({
      key,
      rxNumber: first.rxNumber,
      fillNumber: first.fillNumber,
      dateFilled: first.dateFilled,
      ndc11: first.ndc11,
      itemName: rows.find((r) => r.itemName)?.itemName ?? null,
      payers,
      coordinated: payers.length > 1,
      quantityThousandths,
      remitCents,
      patientPaidCents,
      laterPaymentsCents,
      laterPayments: mine.map((p) => ({ source: p.source, payer: p.payer, amountCents: p.amountCents })),
      revenueCents,
      patientShareUncertain,
      acquisitionCents,
      marginCents: acquisitionCents === null ? null : revenueCents - acquisitionCents,
      reportedMarginCents,
      agreesWithReport:
        reportedMarginCents === null || acquisitionCents === null || laterPaymentsCents !== 0
          ? null
          : Math.abs(revenueCents - acquisitionCents - reportedMarginCents) <= 2,
    });
  }
  return out.sort((a, b) => b.dateFilled.localeCompare(a.dateFilled) || a.rxNumber.localeCompare(b.rxNumber));
}

/** Fills that lost money, worst first. Only where the cost is actually known. */
export function fillsAtALoss(fills: Fill[]): Fill[] {
  return fills.filter((f) => f.marginCents !== null && f.marginCents < 0).sort((a, b) => a.marginCents! - b.marginCents!);
}

/**
 * What the grouping changed, so the correction can be seen rather than believed.
 *
 * Somebody who has been staring at a red number wants to know it moved for a reason.
 */
export function coordinationEffect(fills: Fill[]): {
  fills: number;
  coordinatedFills: number;
  /** Losses that were only losses because a fill was counted as two claims. */
  falseLosses: number;
  falseLossCents: number;
} {
  let coordinatedFills = 0;
  let falseLosses = 0;
  let falseLossCents = 0;
  for (const f of fills) {
    if (!f.coordinated) continue;
    coordinatedFills++;
    if (f.marginCents === null || f.acquisitionCents === null) continue;
    // What the primary alone would have looked like: its remit and copay against the whole bottle.
    const primary = f.payers[0];
    const alone = primary.remitCents + primary.copayCents - f.acquisitionCents;
    if (alone < 0 && f.marginCents >= 0) {
      falseLosses++;
      falseLossCents += -alone;
    }
  }
  return { fills: fills.length, coordinatedFills, falseLosses, falseLossCents };
}
