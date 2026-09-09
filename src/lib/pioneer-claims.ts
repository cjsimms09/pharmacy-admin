/**
 * Rebuilding a fill from PioneerRx's claim rows, when a fill can have more than one payer.
 *
 * The owner: "Secondary claims are not another claim are they? Same claim but 2 payors." Exactly
 * so, and it is the whole difficulty. One prescription, one dispensing, one script on the count —
 * but two payers each paying part, and a patient owing what is left. The money adds up across the
 * payers; the script must not.
 *
 * Three things had to be established against the live database before any of this could be written,
 * because every one of them was guessed wrong first:
 *
 * 1. `IsLatestClaimRecord = 1` returns one row per *fill*, not one per payer. On a two-payer fill it
 *    keeps whichever claim was transmitted last and discards the other, so the feed that used it saw
 *    one side of each and could not tell which side it had. That is the bug this module exists to
 *    end.
 * 2. `ClaimID` is a uniqueidentifier, so `max(ClaimID)` does not mean "the latest claim". Ordering
 *    by it is meaningless; `Transmission.CreatedOn` and `TransmittedDate` are the real sequence.
 * 3. `IsPrimaryThirdParty` is not the coordination-of-benefits position. `PrimaryClaimID` is: it is
 *    null on the fill's first payer and points at that payer's claim on the second.
 *
 * The correct set of claims for a fill is `IsDuplicateClaim = 0` and `IsLastValidClaimForPayMethod
 * = 1` and `TransactionResponseStatus = 'P'` — the current valid paid claim for each payer, after
 * reversals and rebills have settled. Proved on September: it gives $136,104.14 of insurance money,
 * which is PioneerRx's own per-fill total price less its own patient figure, to the penny.
 *
 * And the identity that makes the arithmetic checkable, which holds on all 37 of September's
 * two-payer fills with no difference at all:
 *
 *     sum(NetAmountPaid) + sum(PatientPayAmount) = the fill's total price
 *
 * Summing the patient's share across payers is safe *here* and nowhere else. PioneerRx puts the
 * whole remaining patient responsibility on the last payer in the chain and zeroes it on the
 * earlier one — on September's 37 two-payer fills the primaries carry $0.00 of patient pay between
 * them. The raw NCPDP field on `Prescription.Claim` does the opposite: there the primary states the
 * balance it passed on, and adding it to the secondary's would count the same dollar twice, to the
 * tune of $50,644.55 across the month. This module reads the remittance-pricing figures for that
 * reason, and the difference between the two is the single easiest way to overstate a month.
 */

/** One current, paid claim: one payer's answer on one fill. */
export type PioneerClaimRow = {
  rxNumber: string;
  fillNumber: number;
  /** Null on the fill's first payer; the primary's claim id on a later payer. The COB position. */
  primaryClaimId: string | null;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  networkId: string | null;
  planId: string | null;
  contractId: string | null;
  /** What this payer paid, net. */
  netPaidCents: number | null;
  /** What the patient owes after this payer. Nought on every payer but the last. */
  patientPayCents: number | null;
  otherPayerCents: number | null;
  /** Fill-level facts, taken from the first payer's claim. */
  itemName: string | null;
  ndc11: string | null;
  gcn: string | null;
  quantityThousandths: number | null;
  daysSupply: number | null;
  basisOfReimbursement: string | null;
  basisOfCostDetermination: string | null;
  dispensingFeeCents: number | null;
  dirFeeCents: number | null;
  evoucherCents: number | null;
  acquisitionCents: number | null;
  filledOn: string | null;
  /** PioneerRx's own answer for the whole fill, where it has one, so the identity can be checked. */
  fillTotalPriceCents: number | null;
};

export type PayerSide = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  networkId: string | null;
  planId: string | null;
  planCode: string | null;
  contractId: string | null;
  remitCents: number | null;
  copayCents: number | null;
  otherPayerAmountCents: number | null;
};

export type PioneerFill = {
  rxNumber: string;
  fillNumber: number;
  primary: PayerSide;
  secondary: PayerSide | null;
  /** Every payer beyond the second, which the site has nowhere to put but must never lose silently. */
  furtherPayers: PayerSide[];
  itemName: string | null;
  ndc11: string | null;
  gcn: string | null;
  quantityThousandths: number | null;
  daysSupply: number | null;
  basisOfReimbursement: string | null;
  basisOfCostDetermination: string | null;
  dispensingFeeCents: number | null;
  dirFeeCents: number | null;
  evoucherCents: number | null;
  acquisitionCents: number | null;
  filledOn: string | null;
  /** What every payer on the fill paid together. */
  insuranceCents: number;
  /** What the patient owes, which lives on the last payer in the chain. */
  patientCents: number;
  fillTotalPriceCents: number | null;
};

export type FillsReport = {
  fills: PioneerFill[];
  /** Fills where the payers and the patient do not add up to PioneerRx's own total for the fill. */
  disagree: { rxNumber: string; fillNumber: number; addsToCents: number; fillSaysCents: number }[];
  /** Anything the shape could not hold, in words. Never silent. */
  problems: string[];
  payerCounts: { onePayer: number; twoPayers: number; more: number };
};

const sideOf = (r: PioneerClaimRow): PayerSide => ({
  bin: r.bin,
  pcn: r.pcn,
  groupNumber: r.groupNumber,
  networkId: r.networkId,
  planId: r.planId,
  planCode: null,
  contractId: r.contractId,
  remitCents: r.netPaidCents,
  copayCents: r.patientPayCents,
  otherPayerAmountCents: r.otherPayerCents,
});

/**
 * One fill per prescription and refill, with its payers in coordination order.
 *
 * The order the rows arrive in is not trusted for anything. The reader this replaces assigned the
 * first row it saw to the primary slot whatever its flag said, so a secondary that happened to come
 * back first became the primary and was then overwritten by the real one — the secondary lost twice
 * over. Position here comes only from `primaryClaimId`.
 */
export function fillsFromClaimRows(rows: PioneerClaimRow[]): FillsReport {
  const byFill = new Map<string, PioneerClaimRow[]>();
  for (const r of rows) {
    if (!r.rxNumber) continue;
    const key = `${r.rxNumber}|${r.fillNumber}`;
    byFill.set(key, [...(byFill.get(key) ?? []), r]);
  }

  const fills: PioneerFill[] = [];
  const disagree: FillsReport["disagree"] = [];
  const problems: string[] = [];
  const payerCounts = { onePayer: 0, twoPayers: 0, more: 0 };

  for (const claims of byFill.values()) {
    const firsts = claims.filter((c) => c.primaryClaimId === null);
    const laters = claims.filter((c) => c.primaryClaimId !== null);
    const head = firsts[0] ?? laters[0];
    if (!head) continue;

    if (firsts.length > 1) {
      problems.push(
        `Rx ${head.rxNumber}-${head.fillNumber} has ${firsts.length} claims that each say they are the fill's first payer. The first is taken as primary and the rest as later payers; a fill cannot have two firsts.`,
      );
    }
    if (firsts.length === 0) {
      problems.push(
        `Rx ${head.rxNumber}-${head.fillNumber} has a later payer but no first one. Its money is counted and the payer is filed as the primary, because there is nothing before it, but the chain is incomplete.`,
      );
    }

    /*
     * Coordination order: the first payer, then everyone billed after it. Beyond a second payer the
     * site's shape runs out, so the rest are carried in `furtherPayers` and their money still counts
     * in the totals. A pharmacy sees a tertiary rarely; losing one quietly is how a rare thing
     * becomes a wrong number.
     */
    const ordered = [...firsts, ...laters];
    const primary = sideOf(ordered[0]);
    const secondary = ordered.length > 1 ? sideOf(ordered[1]) : null;
    const furtherPayers = ordered.slice(2).map(sideOf);
    if (furtherPayers.length > 0) {
      problems.push(
        `Rx ${head.rxNumber}-${head.fillNumber} has ${ordered.length} payers. The site holds two; the money from the rest is counted in the totals but has nowhere on the claim to sit.`,
      );
    }

    if (ordered.length === 1) payerCounts.onePayer++;
    else if (ordered.length === 2) payerCounts.twoPayers++;
    else payerCounts.more++;

    const insuranceCents = ordered.reduce((n, c) => n + (c.netPaidCents ?? 0), 0);
    const patientCents = ordered.reduce((n, c) => n + (c.patientPayCents ?? 0), 0);
    const fillTotalPriceCents = head.fillTotalPriceCents;

    /*
     * The check that makes the arithmetic worth trusting: what the payers paid plus what the patient
     * owes is the price of the fill. A penny per payer is allowed, because each figure is a rounded
     * currency value in its own right; anything more is named rather than absorbed.
     */
    if (fillTotalPriceCents !== null) {
      const addsTo = insuranceCents + patientCents;
      if (Math.abs(addsTo - fillTotalPriceCents) > ordered.length) {
        disagree.push({ rxNumber: head.rxNumber, fillNumber: head.fillNumber, addsToCents: addsTo, fillSaysCents: fillTotalPriceCents });
      }
    }

    fills.push({
      rxNumber: head.rxNumber,
      fillNumber: head.fillNumber,
      primary,
      secondary,
      furtherPayers,
      itemName: head.itemName,
      ndc11: head.ndc11,
      gcn: head.gcn,
      quantityThousandths: head.quantityThousandths,
      daysSupply: head.daysSupply,
      basisOfReimbursement: head.basisOfReimbursement,
      basisOfCostDetermination: head.basisOfCostDetermination,
      dispensingFeeCents: head.dispensingFeeCents,
      dirFeeCents: head.dirFeeCents,
      evoucherCents: head.evoucherCents,
      acquisitionCents: head.acquisitionCents,
      filledOn: head.filledOn,
      insuranceCents,
      patientCents,
      fillTotalPriceCents,
    });
  }

  return { fills, disagree, problems, payerCounts };
}
