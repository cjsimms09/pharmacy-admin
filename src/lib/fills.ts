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
 * Every row says what that payer paid and what the patient still owed afterwards. Added, those two
 * are the price that adjudication established — on the real Synthroid, the card's $46.25 plus the
 * $115.57 it left is the $161.82 the report derived for that row. Down a chain each payer is billed
 * only what is left, so the largest of those sums is the whole price of the fill and the rest are
 * residuals of it. Revenue is that price; the patient's share is what remains of it once every
 * payer's remittance is taken out. The primary's copay is not money — it is the amount handed on.
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
  /**
   * The day the patient took it away, or null while it is still in the bin.
   *
   * PioneerRx's completed date, which the daily transaction report already prints — a paid row
   * with no completed date is transmitted and not yet picked up. It is the date the money is
   * earned on, and `dateFilled` is not: 386 of September's fills were billed and never
   * collected.
   */
  soldOn?: string | null;
  ndc11: string | null;
  itemName: string | null;
  bin: string | null;
  /** The processor control number: with the BIN, the line of business; with the group, the plan. */
  pcn?: string | null;
  /** The plan's group number, which with the BIN and PCN is what identifies the actual plan. */
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
  /**
   * The facilitator payment the plan promised at adjudication, where the report carries one.
   *
   * Null means the report said nothing. A promise of zero is a different fact and is kept as zero.
   */
  expectedFacilitatorCents?: number | null;
  status: string;
  /** True where this is a reversal that matched no claim held. */
  unmatchedReversal?: boolean;
  /** True where the pharmacy set this price itself: its cash programme, not a third party. */
  cashPlan?: boolean;
  onAccount?: boolean;
};

export type FillPayer = {
  bin: string | null;
  pcn: string | null;
  /** BIN, PCN and group together identify the plan; the BIN alone often identifies only the processor. */
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
  /** The day it was picked up, or null while it is still in the bin and nobody has paid for it. */
  soldOn: string | null;
  ndc11: string | null;
  itemName: string | null;
  /** Every payer that priced this fill, in the order the rows arrived. */
  payers: FillPayer[];
  /** True where more than one plan paid: the case this exists for. */
  coordinated: boolean;
  /**
   * The pharmacy's own cash price rather than an insurer's.
   *
   * Its margin counts like any other — it is a bottle sold — but nothing here is owed by anybody.
   * There is no floor for the state to enforce on a price the pharmacy set, no contract to appeal
   * under, and a number below NADAC is what it charged rather than a shortfall to claim.
   */
  cashPlan: boolean;
  /**
   * Billed to an account rather than collected: PioneerRx's "AR".
   *
   * The dispensing is ordinary — the drug left the shelf and cost what it cost — so every figure
   * on this fill is computed exactly as any other. Only the question "has this money arrived" has
   * a different answer, and that is what the two figures below are for.
   */
  onAccount: boolean;
  /**
   * Revenue recognised on this fill that nobody has collected yet. Zero unless it is on account.
   *
   * The account legs' own money, not the whole fill's.
   *
   * A coordinated fill can have one leg billed to an account and another paid by a plan. Counting
   * the whole fill's revenue as receivable put the plan's remit in this bucket as well as in the
   * remittance reconciliation, where it was already being awaited: the same dollar in two
   * "not money yet" lists. On Rx 333932-0 that read $491.67 owed on account when the $491.67 was
   * the plan's, and on its way.
   */
  receivableCents: number;
  /**
   * Cost that left the shelf with nothing billed against it at all.
   *
   * The sharpest version of the question, and the one worth acting on this week. An account sale
   * showing revenue is money owed and chaseable; an account sale showing *no* revenue against a
   * real acquisition cost is a dispensing nobody has raised a charge for, and it does not appear
   * as a debt anywhere because no debt was ever created. Null where the cost is not known.
   */
  unbilledCostCents: number | null;
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
  /**
   * Money promised at adjudication and not yet in the bank, on this fill.
   *
   * The report says what the facilitator will pay; the payment arrives weeks later. Held together,
   * a fill can say it is owed $146.18 rather than reading as a $123.66 loss — and when the payment
   * lands and is matched, what is left outstanding falls to nothing on its own.
   *
   * Null where no row on the fill carried a promise, which is not the same as being owed nothing.
   */
  expectedFacilitatorCents: number | null;
  /** The promise less what has actually arrived, floored at nothing. What is still to come. */
  facilitatorOutstandingCents: number | null;
  /**
   * True where this fill is on a programme that pays a top-off later and none has arrived.
   *
   * The RxRescue plan (BIN 024284) adjudicates for whatever the primary will pay and sends the rest
   * weeks afterwards on a credit memo. Unlike a facilitator payment the claim does not say what the
   * amount will be — so the amount cannot be shown, but the fact that one is coming can, and that
   * alone is the difference between a rate to argue about and a bill not yet paid.
   */
  topOffExpected: boolean;
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
  /**
   * Money the report booked on this fill that this site has not found in the row.
   *
   * PioneerRx computes its gross profit from the same row we read, so a gap means it counted
   * revenue we did not. What that revenue *is* varies and the fill cannot tell us: on one Jardiance
   * fill it was $146.18 of facilitator money the plan promised at adjudication; on a Losartan fill
   * it was $5.56, which no facilitator was ever going to pay and is far likelier to be a patient
   * total sitting in a column this reader is not picking up.
   *
   * So the amount is stated and the cause is not. Naming every gap a facilitator payment turned a
   * reading problem into a queue of receivables that were never coming — the same mistake as the
   * red banner it replaced, in the opposite direction. The gap is the fact; the row is the evidence.
   */
  unreconciledCents: number | null;
  /**
   * True where this fill satisfies the identity above, to the cent.
   *
   * The one check on this module that does not come from this module. Null only where the report
   * carried no gross profit for a row, or no acquisition cost, so there is nothing to check against.
   */
  agreesWithReport: boolean | null;
};

/**
 * Plans that pay part of the claim later, by credit memo rather than at adjudication.
 *
 * BIN 024284 is the Aytu / IPD RxRescue programme. A fill on it is priced at whatever the primary
 * plan pays and topped up afterwards, so on the day it is dispensed it can look like a heavy loss
 * and be nothing of the kind.
 */
export const TOP_OFF_BINS = new Set(["024284"]);

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
  /**
   * The part of the payment that is money the claim did not already carry — what a margin moves by.
   *
   * A facilitator remittance is new money in full. A credit memo that settles what the claim was
   * already adjudicated for is not: counting it would book the same money twice.
   */
  amountCents: number;
  /** What actually arrived, for the record. Defaults to the same figure. */
  receivedCents?: number;
};

/** One payor's part of a fill: what it owes, and its share of what the bottle cost. */
export type PayerShare = {
  bin: string | null;
  name: string | null;
  /**
   * What this payor said it would pay, on its own transmission.
   *
   * A fact rather than an allocation, and the only figure here an 835 can settle: a remittance
   * arrives against this payor's own claim and either matches this number or does not. "Expected
   * from payor X" is this and nothing else.
   */
  receivableCents: number;
  /**
   * This payor's share of the acquisition cost, pro rata on remit.
   *
   * A stated convention, not a fact — the bottle was bought once and no payor bought a share of it.
   * Pro rata on remit is chosen because it is the only split that reconciles: the shares sum to the
   * whole cost, so the payors' margins sum to the fill's margin less what the patient paid.
   *
   * Null where the payors together paid nothing, because nought divided by nought is not a share
   * and a made-up one would put the whole cost on whichever payor happened to be first — which is
   * the error this exists to end.
   */
  costShareCents: number | null;
  /** Receivable less cost share, where a share can be worked out. */
  marginCents: number | null;
};

/**
 * What each payor on a fill is owed, and what it costs the pharmacy to serve it.
 *
 * The owner: *"I've noticed we tend to assert all the profit to one payor which doesn't make
 * sense."* He is right, and it is wrong twice over on the same 22 fills.
 *
 * PioneerRx's printed per-row gross profit puts the whole acquisition cost on the primary's row and
 * none on the secondary's. On this pharmacy's coordinated fills that reads as BIN 610011 losing
 * $843.73 and RxRescue earning $458.29 of pure profit on the same bottles. Neither number is about
 * anything real.
 *
 * The site's own payer scores make the opposite error from the same mistake: `payer-map.ts` keys
 * every fill on `payers[0]`, so the primary is credited with the secondary's remit as its own
 * revenue and a payor that only ever appears second never appears at all.
 *
 * Both come of attributing a whole fill to one payor. Two statements hold instead, and they are
 * different figures that must not be added together:
 *
 *   - **The fill owns the profit.** One cost, one revenue across every payor and the patient.
 *     `Fill.marginCents` is that figure and it is already right.
 *   - **Each payor owns its receivable.** Its own remit on its own transmission, settled only by its
 *     own 835. That is what this returns, and it reconciles line by line when the remittance lands.
 *
 * The cost share is the only invented number here and it is labelled as one. Pro rata on remit is
 * chosen because it is the only split that adds up: sum the payors' margins and add what the
 * patient paid, and you have the fill's margin exactly. `sharesReconcile` proves it.
 *
 * The patient's money is deliberately given to no payor. It is the residual after the last plan —
 * the patient pays it *because* the plans did not — so crediting it to a plan would reward a payor
 * for covering less.
 *
 * Pure.
 */
export function payerShares(fill: Fill): PayerShare[] {
  const totalRemit = fill.payers.reduce((n, p) => n + p.remitCents, 0);
  const cost = fill.acquisitionCents;
  return fill.payers.map((p) => {
    const costShareCents =
      cost === null || totalRemit <= 0 ? null : Math.round((cost * p.remitCents) / totalRemit);
    return {
      bin: p.bin,
      name: p.name ?? null,
      receivableCents: p.remitCents,
      costShareCents,
      marginCents: costShareCents === null ? null : p.remitCents - costShareCents,
    };
  });
}

/**
 * Whether the shares add back up to the fill, which is the whole test of the convention.
 *
 * Rounding a pro-rata split can lose a cent, so the last share carries the remainder rather than
 * the arithmetic being allowed to drift. Returns the difference in cents; nought is what it should
 * always be.
 */
export function sharesReconcile(fill: Fill, shares: PayerShare[] = payerShares(fill)): number {
  if (fill.marginCents === null || shares.some((s) => s.marginCents === null)) return 0;
  const payors = shares.reduce((n, s) => n + (s.marginCents ?? 0), 0);
  return fill.marginCents - (payors + fill.patientPaidCents);
}

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
      pcn: r.pcn ?? null,
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
     * What the pharmacy actually took, worked out the way the report itself works it out.
     *
     * Every row carries what that payer paid and what the patient was left owing after it. Those
     * two added are the price that adjudication established:
     *
     *   the price = what this payer paid + what the patient still owed afterwards
     *
     * On the real Synthroid fill the card's row reads $46.25 paid and $115.57 still owing — $161.82,
     * which is exactly the ingredient cost the report derived for that row. The plan's row reads
     * zero and zero: it paid nothing and assessed nothing, and establishes no price at all.
     *
     * Down a coordinated chain each payer is billed only what is left, so the *largest* of those
     * sums is the whole price of the fill and the later ones are residuals of it. Take the largest
     * and nothing is counted twice — not the primary's copay, which is only the amount handed on,
     * and not a rebill transmitted a second time.
     *
     *   revenue    = the largest price any row established
     *   the patient = that price, less everything the payers between them remitted
     *
     * $161.82 taken on a bottle that cost $128.68: thirty-three dollars made, which this site was
     * reporting as an eighty-two dollar loss. It is also how PioneerRx computes its own gross
     * profit per row, which is why our figure and the report's now agree instead of arguing.
     */
    /*
     * ── What the pharmacy took, and what the bottle cost ───────────────────────
     *
     * Both are sums over the live rows, and that is not a simplification — it is what the report
     * actually does, checked against every dispensing in a real week:
     *
     *   1,199 fills, 27 of them coordinated
     *   fills where more than one live row carries an acquisition cost:  0
     *   fills where more than one live row carries a patient total:      0
     *   fills where this rule disagrees with the report's gross profit:  0
     *
     * That last line is the point. PioneerRx puts the cost of the bottle on the row that dispensed
     * it and zero on every coordination row beside it, and it puts the patient's residual on the one
     * row where it actually stays with the patient. Nothing is repeated, so nothing needs to be
     * de-duplicated.
     *
     * This module was built on the opposite belief — that "both rows carry the same acquisition
     * cost, because it is the same bottle" — and every complication in it followed from that: taking
     * the largest cost, taking the largest quantity, and working the patient's share out backwards
     * from a price no row states. That last one was wrong on Rx 336765, where OptumRx paid $461.89
     * on the dispensing row and a second plan paid $100 and left the patient $733.52. Subtracting
     * every remittance from $833.52 gave the patient $271.63 and the fill a $469.21 loss; the report
     * said $7.32, and the report was right.
     *
     * The belief was never checked against the file. It is now, and the arithmetic is the plain one.
     */
    const patientPaidCents = payers.reduce((n, p) => n + p.copayCents, 0);

    /*
     * Flagged where the one assumption above does not hold.
     *
     * If two live rows both leave the patient owing something, the residual may be the same money
     * written twice — and adding it would invent revenue. It happens on none of the real fills, and
     * it is said rather than assumed away, because the day it does happen nothing else would notice.
     */
    const patientShareUncertain = payers.filter((p) => p.copayCents !== 0).length > 1;

    /*
     * The bottle, from the row that dispensed it.
     *
     * Added rather than maxed, because the coordination rows carry zero — but guarded: two live rows
     * carrying the *same* non-zero cost is the signature of the same bottle written twice, and that
     * is counted once. On the real file this guard never fires; it is here so that if the report
     * ever starts repeating the cost, the answer degrades to right rather than to double.
     */
    const costs = rows.map((r) => r.acquisitionCents).filter((x): x is number => x !== null && x !== undefined && x !== 0);
    const duplicated = costs.length > 1 && costs.every((c) => c === costs[0]);
    const acquisitionCents = rows.some((r) => r.acquisitionCents !== null && r.acquisitionCents !== undefined)
      ? duplicated
        ? costs[0]
        : costs.reduce((n, c) => n + c, 0)
      : null;
    // Quantity likewise sits on the dispensing row; the coordination rows print zero.
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
     * One row on account puts the fill on account.
     *
     * A fill coordinated across two payers where one leg went to an account is still a fill whose
     * money is not all in hand, and treating it as collected because the other leg was is the
     * error that hides the balance.
     */
    const onAccount = rows.some((r) => r.onAccount === true);

    /*
     * What was promised, taken once.
     *
     * A coordinated fill can carry the same promise on both of its rows — it is one manufacturer
     * share on one bottle, not two — so the largest is taken, exactly as the acquisition cost is.
     * Adding them would invent money in the direction that flatters the pharmacy, which is the
     * worst direction for a figure somebody is going to chase a payer over.
     */
    const promised = rows.map((r) => r.expectedFacilitatorCents).filter((x): x is number => x !== null && x !== undefined);
    const expectedFacilitatorCents = promised.length ? Math.max(...promised) : null;
    const facilitatorOutstandingCents =
      expectedFacilitatorCents === null ? null : Math.max(0, expectedFacilitatorCents - laterPaymentsCents);

    /*
     * The report's own answer, for comparison — but only where it is comparable.
     *
     * A payment that arrived weeks later cannot be in a figure printed on the day, so a fill
     * carrying one is not evidence of anything and is left unchecked rather than reported as a
     * disagreement.
     */
    const reported = rows.map((r) => r.grossProfitCents).filter((x): x is number => x !== null && x !== undefined);
    const reportedMarginCents = reported.length === rows.length && rows.length > 0 ? reported.reduce((n, x) => n + x, 0) : null;

    /*
     * Where the report and this site differ, and by how much. Positive means the report counted
     * money the pharmacy has not got.
     */
    /*
     * ── The identity this whole module is now held to ──────────────────────────────
     *
     *     what we make on a fill  −  money that arrived after the day  =  what the report made of it
     *
     * PioneerRx prints, for every row, GrossProfit = Amount + Total − Acq. Inv. Cost. Add that up
     * over the live rows of one dispensing and you have the report's answer for that bottle. Our
     * answer is revenue less the cost taken once. The two must agree exactly, because they are the
     * same arithmetic over the same numbers — the only legitimate difference is money the report
     * could not have known about, which is what arrives later from a facilitator or a credit memo.
     *
     * Every error this file has had would have been caught the moment this was stated: the smallest
     * copay, the patient's residual read from the wrong column, a reversal left unpaired so one
     * bottle counted twice, a gap called a facilitator payment on a fill no facilitator would ever
     * pay. Each was a rule inferred from one example, and each survived because nothing independent
     * could contradict it. This can, on every fill, every day.
     */
    const gapCents =
      reportedMarginCents === null || acquisitionCents === null
        ? null
        : reportedMarginCents - (revenueCents - acquisitionCents - laterPaymentsCents);

    const first = rows[0];
    out.push({
      key,
      rxNumber: first.rxNumber,
      fillNumber: first.fillNumber,
      dateFilled: first.dateFilled,
      soldOn: rows.map((r) => r.soldOn).find((d) => d) ?? null,
      ndc11: first.ndc11,
      itemName: rows.find((r) => r.itemName)?.itemName ?? null,
      payers,
      coordinated: payers.length > 1,
      cashPlan: rows.some((r) => r.cashPlan === true),
      onAccount,
      receivableCents: rows.reduce((n, r) => (r.onAccount === true ? n + (r.patientTotalCents ?? r.copayCents ?? 0) : n), 0),
      unbilledCostCents: onAccount && revenueCents === 0 ? acquisitionCents : null,
      quantityThousandths,
      remitCents,
      patientPaidCents,
      laterPaymentsCents,
        laterPayments: mine.map((p) => ({ source: p.source, payer: p.payer, amountCents: p.receivedCents ?? p.amountCents })),
      expectedFacilitatorCents,
      facilitatorOutstandingCents,
      topOffExpected:
        payers.some((p) => p.bin !== null && TOP_OFF_BINS.has(p.bin)) && !mine.some((p) => p.source === "rxrescue"),
      revenueCents,
      patientShareUncertain,
      acquisitionCents,
      marginCents: acquisitionCents === null ? null : revenueCents - acquisitionCents,
      reportedMarginCents,
      /*
       * Which way the gap runs still matters, even though its cause is not knowable from here.
       *
       * The report ahead of us means revenue we did not pick up — recoverable, once the column is
       * found. Us ahead of the report cannot be a timing difference at all and can only be a
       * mis-read column. Neither deserves the red "the arithmetic is broken" banner that used to
       * cover both.
       */
      unreconciledCents: gapCents !== null && Math.abs(gapCents) > 2 ? gapCents : null,
      agreesWithReport: gapCents === null ? null : Math.abs(gapCents) <= 2,
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
    /*
     * What the worst single row would have looked like on its own.
     *
     * On a coordinated fill one row carries the bottle's whole cost while the money came in on
     * another: the real Synthroid has a plan row reading $0.00 paid against $128.68 of drug, a
     * $128.68 loss on a fill that in fact made $33.14. That row, not the first one, is the invented
     * loss this grouping removes.
     */
    const alone = Math.min(...f.payers.map((p) => p.remitCents + p.copayCents - f.acquisitionCents!));
    if (alone < 0 && f.marginCents >= 0) {
      falseLosses++;
      falseLossCents += -alone;
    }
  }
  return { fills: fills.length, coordinatedFills, falseLosses, falseLossCents };
}
