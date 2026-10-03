/**
 * Whether a claim is settled, and where every dollar of it went.
 *
 * The owner, 11 September 2026: *"should be easy to see claim is reconciled and here is the reason
 * we didnt get what we expected."* And, of the accounting: *"basically anytime we werent paid as
 * much as pioneer thinks we would."*
 *
 * ── The two questions, which are not the same question ──
 *
 * A first attempt at this compared PioneerRx's expected payment against what arrived, and tried to
 * explain the gap with the remittance's CAS adjustments. It was wrong, and the tests caught it: a
 * primary paying exactly what was expected came out "overpaid", because its $30 contractual
 * write-off was being subtracted from a figure that already had the contract in it.
 *
 * There are two checks and they answer different things:
 *
 *   **Does the payer's own arithmetic balance?** An 835 says what was charged, what it paid, and
 *   what it deducted and why. Charge minus adjustments must equal paid. When it does not, the file
 *   was misread or is malformed — a fault in the reading, not in the money.
 *
 *   **Did we get what PioneerRx expected?** PioneerRx already knows the contract, so its expected
 *   figure has the contractual write-off baked in. Only a gap between *that* and what arrived is a
 *   shortfall, and only that gap touches the accounts.
 *
 * A $100 charge where the plan writes off $30 under contract, leaves $10 to the patient and sends
 * $60 is completely ordinary. PioneerRx expected $60, $60 came: reconciled, nothing adjusted. The
 * CAS breakdown is still worth keeping and showing — it is the explanation of the payer's working —
 * but it is not by itself evidence of anything wrong.
 *
 * Pure. No database, no dates, no formatting — given the numbers, it says what they mean.
 */

/** CAS01. The four groups an 835 uses, plus whatever a payer invents. */
export type AdjustmentGroup = "CO" | "PR" | "PI" | "OA" | (string & {});

export type Adjustment = {
  groupCode: AdjustmentGroup;
  /** As the payer printed it. Never normalised: an unknown code must stay visible as itself. */
  reasonCode: string;
  amountCents: number;
};

export type ReconcileInput = {
  /**
   * What PioneerRx said this payer would pay. The figure the pharmacy accrued on.
   *
   * The contract is already in it, which is why a contractual write-off in the remittance is not a
   * shortfall against it.
   */
  expectedCents: number;
  /** CLP03: what was billed. Null where the remittance did not say. */
  chargedCents?: number | null;
  /** CLP04: what the payer actually sent. Null where no remittance has arrived. */
  paidCents: number | null;
  /** CAS: what the payer deducted from the charge, and why. */
  adjustments: Adjustment[];
  /** What PioneerRx recorded the patient owed, where it knows. Used to check PR, not to set it. */
  copayCents?: number | null;
};

export type ReconcileState =
  /** No remittance has arrived. Not a problem — a receivable. */
  | "awaiting"
  /** What arrived is what PioneerRx expected. Settled. */
  | "reconciled"
  /** Less arrived than expected, and the remittance names a reason that accounts for it. */
  | "short_explained"
  /** Less arrived than expected and nothing explains it. The state that needs a person. */
  | "unexplained"
  /** More arrived than expected. Worth knowing: overpayments tend to be clawed back. */
  | "overpaid";

export type Reconciliation = {
  state: ReconcileState;
  expectedCents: number;
  paidCents: number;
  /** Expected minus paid. Positive means less arrived than PioneerRx thought it would. */
  shortfallCents: number;

  // ── The payer's own breakdown, kept because it explains their working ──
  /** Written off under the contract. Already inside what PioneerRx expected. */
  contractualCents: number;
  /** The patient's share, as the plan sees it. */
  patientCents: number;
  /** The plan chose to reduce what it paid. The usual real cause of a shortfall. */
  payerInitiatedCents: number;
  /** Anything the plan named that is none of the above. */
  otherCents: number;

  /**
   * Whether the payer's own arithmetic adds up: charge − adjustments = paid.
   *
   * Null when the charge is unknown. A non-zero value is a reading fault, not a money problem, and
   * is reported separately so it never gets mistaken for a shortfall.
   */
  payerArithmeticOffCents: number | null;

  /** How much of the shortfall the remittance accounts for. */
  explainedCents: number;
  /** What nothing accounts for. Zero unless the state is `unexplained`. */
  unexplainedCents: number;
  /**
   * How much this reduces accrued revenue.
   *
   * The explained part of a shortfall does: the plan has said it is not paying it. An unexplained
   * residue does not — nobody has said that money is not owed, which is precisely what makes it
   * unexplained, and writing it off here would turn "we do not know why" into "we have decided not
   * to be paid", silently, on a figure nobody has looked at.
   */
  revenueAdjustmentCents: number;
  /**
   * Where the plan's view of the patient's share disagrees with PioneerRx's copay.
   *
   * Null when either side is unknown, or when the remittance named no adjustments at all — a
   * remittance that said nothing has not disagreed, and reporting that as a disagreement of the
   * whole copay would bury the real ones.
   */
  copayDisagreesCents: number | null;
};

/** Below this, a difference is rounding rather than a finding. Matches the remit check. */
export const RECONCILE_TOLERANCE_CENTS = 2;

/**
 * Settle one payer leg.
 *
 * Adjustments are summed by group rather than netted into one number, because the groups mean
 * genuinely different things and saying which is which is the entire point.
 */
export function reconcileClaim(input: ReconcileInput): Reconciliation {
  const expectedCents = Math.round(input.expectedCents);
  const group = (a: Adjustment) => (a.groupCode ?? "").toUpperCase();
  const by = (g: string) =>
    input.adjustments.filter((a) => group(a) === g).reduce((n, a) => n + Math.round(a.amountCents), 0);

  const contractualCents = by("CO");
  const patientCents = by("PR");
  const payerInitiatedCents = by("PI");
  const known = new Set(["CO", "PR", "PI"]);
  const otherCents = input.adjustments
    .filter((a) => !known.has(group(a)))
    .reduce((n, a) => n + Math.round(a.amountCents), 0);
  const allAdjustments = contractualCents + patientCents + payerInitiatedCents + otherCents;

  const copayDisagreesCents =
    input.copayCents === null || input.copayCents === undefined || input.adjustments.length === 0
      ? null
      : Math.round(input.copayCents) - patientCents;

  const base = {
    expectedCents,
    contractualCents,
    patientCents,
    payerInitiatedCents,
    otherCents,
    copayDisagreesCents,
  };

  if (input.paidCents === null) {
    return {
      ...base,
      state: "awaiting",
      paidCents: 0,
      shortfallCents: 0,
      payerArithmeticOffCents: null,
      explainedCents: 0,
      unexplainedCents: 0,
      revenueAdjustmentCents: 0,
    };
  }

  const paidCents = Math.round(input.paidCents);

  /*
   * The payer's own books: charge − adjustments = paid. Checked, never used to judge the money.
   *
   * Reported apart from the shortfall because it means something entirely different. A shortfall is
   * a fact about what arrived; this is a fact about whether the file was read correctly.
   */
  const payerArithmeticOffCents =
    input.chargedCents === null || input.chargedCents === undefined
      ? null
      : Math.round(input.chargedCents) - allAdjustments - paidCents;

  const shortfallCents = expectedCents - paidCents;

  if (Math.abs(shortfallCents) <= RECONCILE_TOLERANCE_CENTS) {
    return {
      ...base,
      state: "reconciled",
      paidCents,
      shortfallCents: 0,
      payerArithmeticOffCents,
      explainedCents: 0,
      unexplainedCents: 0,
      revenueAdjustmentCents: 0,
    };
  }

  if (shortfallCents < 0) {
    return {
      ...base,
      state: "overpaid",
      paidCents,
      shortfallCents,
      payerArithmeticOffCents,
      explainedCents: 0,
      unexplainedCents: 0,
      revenueAdjustmentCents: 0,
    };
  }

  /*
   * What can account for arriving short of what PioneerRx expected.
   *
   * Not every adjustment can. A contractual write-off is already inside the expected figure — the
   * contract is what produced it — so counting it here would explain the same money twice and make
   * every ordinary claim look reconciled no matter how short it came.
   *
   * Two things genuinely can:
   *
   *   A payer-initiated reduction, which is the plan deciding to pay less than the contract implies.
   *   That is the usual real cause.
   *
   *   The plan holding the patient responsible for more than PioneerRx charged them. The pharmacy
   *   took the counter copay it was told to take; if the plan then paid as though the patient owed
   *   more, the difference is exactly the gap, and it is explained rather than missing.
   *
   * Anything left after those is a residue nobody has accounted for.
   */
  const copayGap = copayDisagreesCents === null ? 0 : Math.max(0, -copayDisagreesCents);
  const explainedCents = Math.min(shortfallCents, payerInitiatedCents + otherCents + copayGap);
  const unexplainedCents = shortfallCents - explainedCents;

  return {
    ...base,
    state: unexplainedCents > RECONCILE_TOLERANCE_CENTS ? "unexplained" : "short_explained",
    paidCents,
    shortfallCents,
    payerArithmeticOffCents,
    explainedCents,
    unexplainedCents: unexplainedCents > RECONCILE_TOLERANCE_CENTS ? unexplainedCents : 0,
    revenueAdjustmentCents: explainedCents,
  };
}

/** One payer's leg of a fill, primary first. */
export type Leg = ReconcileInput & { payer: string | null };

export type FillReconciliation = {
  /** The worst state across the legs: one unsettled leg leaves the fill unsettled. */
  state: ReconcileState;
  legs: (Reconciliation & { payer: string | null })[];
  /** Every dollar that actually arrived, across all payers. */
  paidCents: number;
  /** What PioneerRx expected across all legs. */
  expectedCents: number;
  /**
   * Money still owed to this pharmacy by somebody.
   *
   * Two things, and they are different: a leg with no remittance yet, and a residue nothing
   * explains. A shortfall the plan has explained is not owed — it has said it is not paying it.
   */
  stillOwedCents: number;
  /** Shortfall the plans have explained. Not owed, and it reduces revenue. */
  writtenOffCents: number;
  /**
   * What the patient actually owed at the counter.
   *
   * The last settled leg's share, not the sum. On a fill billed to two plans the primary leaves a
   * patient share and the secondary is billed for exactly that, so adding both counts the same
   * dollars twice — a $100 fill where the patient paid $2 would read as $12.
   */
  patientShareCents: number;
  /** The primary's patient share that a later payer picked up. Not the patient's money. */
  coveredByAnotherPayerCents: number;
  /** Reduces accrued revenue. */
  revenueAdjustmentCents: number;
  /** Named plainly, because this is the sentence shown beside the fill. */
  says: string;
};

/**
 * Settle a whole fill, across however many payers were billed.
 *
 * The owner: *"we also need to test logic on claims with 2 payors.. these could be tricky.. our
 * system needs to be able to handle lots of different scenarios and differentiate between money
 * still owed vs money that was a write off."*
 *
 * Each payer's 835 settles its own leg and nothing else, so the legs reconcile independently. Three
 * fill-level figures cannot be got by adding legs up, and they are the ones that matter:
 *
 *   The patient's share is the **last** leg's, not the sum. A secondary is billed for exactly what
 *   the primary left as patient responsibility, so both legs describe the same dollars.
 *
 *   A primary's patient share is only the patient's when nothing else was billed for it. Where a
 *   secondary exists it is a receivable from that secondary until its remittance arrives.
 *
 *   Money owed and money written off are different, and only the plan saying so moves a dollar from
 *   the first to the second.
 *
 * Legs must be in billing order, primary first, which is the order the claims carry.
 */
export function reconcileFill(legs: Leg[]): FillReconciliation {
  const settled = legs.map((l) => ({ ...reconcileClaim(l), payer: l.payer }));

  const paidCents = settled.reduce((n, l) => n + l.paidCents, 0);
  const expectedCents = settled.reduce((n, l) => n + l.expectedCents, 0);
  const revenueAdjustmentCents = settled.reduce((n, l) => n + l.revenueAdjustmentCents, 0);
  const writtenOffCents = settled.reduce((n, l) => n + l.explainedCents, 0);

  const awaiting = settled.filter((l) => l.state === "awaiting");
  const awaitingCents = awaiting.reduce((n, l) => n + l.expectedCents, 0);
  const unexplainedCents = settled.reduce((n, l) => n + l.unexplainedCents, 0);

  /*
   * The last leg that has actually spoken sets the patient's share. Where nothing has, the last leg
   * billed is still the best figure to show — it is what the patient was told at the counter.
   */
  const spoke = settled.filter((l) => l.state !== "awaiting");
  const last = spoke.length > 0 ? spoke[spoke.length - 1] : settled[settled.length - 1];
  const patientShareCents = last ? last.patientCents : 0;

  /* Every leg's patient share except the last: each was handed to the next payer, not to the till. */
  const handedOn = settled.slice(0, Math.max(0, settled.length - 1)).reduce((n, l) => n + l.patientCents, 0);
  const anyAwaiting = awaiting.length > 0;

  const state: ReconcileState = settled.some((l) => l.state === "unexplained")
    ? "unexplained"
    : anyAwaiting
      ? "awaiting"
      : settled.some((l) => l.state === "overpaid")
        ? "overpaid"
        : settled.some((l) => l.state === "short_explained")
          ? "short_explained"
          : "reconciled";

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const says =
    state === "reconciled"
      ? `Settled in full: ${money(paidCents)} received, exactly what was expected.`
      : state === "short_explained"
        ? `Settled. ${money(paidCents)} received; the ${money(writtenOffCents)} difference is explained by the plan.`
        : state === "awaiting"
          ? `Waiting on ${awaiting.map((l) => l.payer ?? "a plan").join(" and ")} for ${money(awaitingCents + (anyAwaiting ? handedOn : 0))}.`
          : state === "overpaid"
            ? `More arrived than was expected. Worth checking before it is spent — overpayments tend to be clawed back.`
            : `${money(unexplainedCents)} is missing and nothing in the remittance explains it.`;

  return {
    state,
    legs: settled,
    paidCents,
    expectedCents,
    stillOwedCents: awaitingCents + unexplainedCents + (anyAwaiting ? handedOn : 0),
    writtenOffCents,
    patientShareCents,
    coveredByAnotherPayerCents: anyAwaiting ? 0 : handedOn,
    revenueAdjustmentCents,
    says,
  };
}

/**
 * What a CAS group means, in the words the owner would use.
 *
 * Shown beside a claim so the state is never a code to go and look up. Deliberately says what it
 * means for this pharmacy rather than what the X12 standard calls it.
 */
export function groupMeaning(group: string): { label: string; says: string; costsUs: boolean } {
  switch ((group ?? "").toUpperCase()) {
    case "CO":
      return {
        label: "Contractual",
        says: "Written off under the contract with this plan — already allowed for in what PioneerRx expected.",
        costsUs: false,
      };
    case "PR":
      return {
        label: "Patient's share",
        says: "The patient's copay, deductible or coinsurance — collected at the counter.",
        costsUs: false,
      };
    case "PI":
      return {
        label: "Payer reduction",
        says: "The plan chose to pay less than the contract implies. The usual real cause of a shortfall.",
        costsUs: true,
      };
    case "OA":
      return {
        label: "Other adjustment",
        says: "The plan named a reason that is neither contractual nor the patient's share.",
        costsUs: true,
      };
    default:
      return {
        label: group || "Unlabelled",
        says: "A group code this plan uses that is not one of the four standard ones. Shown as printed.",
        costsUs: true,
      };
  }
}
