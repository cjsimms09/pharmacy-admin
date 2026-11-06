/**
 * Which claim an 835 line is paying, when a fill can have more than one payer.
 *
 * The owner: "We will be able to match remits with 835s?" Not reliably, before this. A fill billed
 * to a primary and a secondary is two claim rows carrying the same prescription number, the same
 * fill number, the same fill date and the same NDC — every field the matcher had. It loosened its
 * conditions one at a time and took the first row that fitted, so an 835 from the secondary payer
 * could be filed against the primary's claim, and the primary would then look settled while the
 * secondary aged. September has 37 such fills.
 *
 * Its own comment said it stopped the moment a level was ambiguous. The code said
 * `if (hits.length >= 1) return hits[0]`, which is the opposite: two candidates was an answer, and
 * the answer was whichever the database happened to return first.
 *
 * So two discriminators the matcher was not using, in the order they can be trusted:
 *
 * 1. **The BIN.** An 835 comes from one payer, and the claim knows which payer it went to. Where
 *    the remittance names a BIN this settles it outright.
 * 2. **The amount.** Two payers on one fill almost never pay the same figure, and the 835 line says
 *    what this payer paid. A claim whose own remit equals it is the claim being settled. The Medicare
 *    Transaction Facilitator pays no remit but a refund, and is read against the refund each claim
 *    itself promised (`facilitatorCents`, the report's "Est. MTF"), never against its remit.
 *
 * And where neither separates the candidates, the answer is no answer. A payment attached to
 * nothing shows up as unmatched and somebody chases it; a payment attached to the wrong claim is
 * invisible, and makes two claims wrong at once — the one credited that was not paid, and the one
 * still owed that looks settled. Refusing is the conservative direction and the loud one.
 *
 * Pure, so it is tested.
 */

export type ClaimCandidate = {
  id: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string | null;
  bin: string | null;
  remitCents: number | null;
  /**
   * Whether this claim carries a manufacturer voucher, and so could be the one a programme is paying.
   *
   * Only consulted for a payment from a voucher programme — see `fromProgramme` below.
   */
  carriesVoucher?: boolean;
  /**
   * What this claim says the Medicare Transaction Facilitator owes on it: the report's "Est. MTF", null where it says nothing and 0 where
   * it says none. A fill billed to a Part D plan and then to the Medicare Prescription Payment Plan is two claims, and only the first
   * carries the refund.
   */
  facilitatorCents?: number | null;
  /**
   * What is already tied to this claim, where the caller read it. A take-back is matched against this and nothing else: its
   * amount is the opposite of the claim's own remit and so can never equal it. Left off, no take-back is matched to a claim.
   */
  tied?: TiedPayment[];
};

/** A payment already tied to a claim: how much, and which source it came from (plan, secondary, copay card and so on). */
export type TiedPayment = { amountCents: number; source: string };

export type RemittanceLine = {
  fillNumber: number | null;
  dateFilled: string | null;
  ndc11: string | null;
  /** What this payer says it paid on this line. */
  amountCents: number | null;
  /** The payer's BIN, where the remittance names one. */
  bin: string | null;
  /**
   * This money is a voucher programme's, so only a claim carrying a voucher can be the one it pays.
   *
   * Found by running the whole chain over September's real claims before a single programme payment
   * for a September fill had arrived (`scripts/voucher-dry-run.ts`, 16 September 2026): of 53 voucher
   * claims, 46 would have attached correctly, none wrongly, and 2 would have been refused as
   * ambiguous — a fill billed to two payers, where RedSail's 835 names no BIN and neither claim was
   * paid exactly the voucher amount.
   *
   * Both refusals were unnecessary, and that is the point. Only one of those two claims carries a
   * voucher at all; the other is the coordinating payer's row, which no manufacturer programme is
   * paying. The site already knew which was which and was not asking. It costs nothing to be wrong
   * about — where it does not single one out, the answer is the refusal it would have given anyway.
   */
  fromProgramme?: boolean;
  /**
   * Where the money came from, as `claim_payments.source` says. A take-back reverses a payment of the same source and of no other, and
   * the facilitator's money is read against each claim's promised refund and not against its remit.
   */
  source?: string | null;
  /**
   * A payment of exactly the opposite amount for this same fill, from the same payer by the same source, is itself tied to no claim and
   * waiting. This take-back is that payment's own and the two cancel (untied-payments.ts `cancellingPairs`): tying it to a claim that
   * happens to hold an equal payment would leave that other one unpaired and the claim taken back for what it kept.
   */
  partnerWaiting?: boolean;
};

export type Choice = {
  claim: ClaimCandidate | null;
  /** Set where candidates were found but none could be singled out. Never silent. */
  ambiguous: { count: number; why: string } | null;
};

const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");

/**
 * The conditions a claim has to meet to be the fill a line is paying, from the strictest to the loosest.
 * One place, so that choosing the claim and saying which claims a payment was for cannot come to different answers.
 */
function levelsFor(line: RemittanceLine): ((r: ClaimCandidate) => boolean)[] {
  /*
   * The most specific match that still identifies one claim, loosening one condition at a time.
   *
   * A credit memo names the prescription, the drug and the day it was dispensed but never the fill
   * number, and a remittance may disagree with the claim about the date by a day — the memo counts
   * the day it was billed, the claim the day it was filled. Insisting on every field at once threw
   * those away as unmatched, and money sitting against nothing is money nobody chases.
   */
  /*
   * Never a different fill. The two loosest levels used to ignore the date altogether, so a payment for April's fill of a
   * monthly prescription attached itself to September's refill whenever April's claim was not on the site — 709 payments,
   * $65,829.59, received before the claim they settled had even been filled (measured 15 September). A refill is a
   * different claim. A day or three either way is the memo counting the day it was billed; a month is another fill.
   */
  const nearDate = (r: ClaimCandidate) => {
    if (line.dateFilled === null) return true;
    const gap = Math.abs(Date.parse(`${r.dateFilled}T00:00:00Z`) - Date.parse(`${line.dateFilled}T00:00:00Z`));
    return Number.isFinite(gap) && gap <= 3 * 86_400_000;
  };
  const levels: ((r: ClaimCandidate) => boolean)[] = [
    (r) => (line.fillNumber === null || r.fillNumber === line.fillNumber) && (line.dateFilled === null || r.dateFilled === line.dateFilled) && (line.ndc11 === null || r.ndc11 === line.ndc11),
    (r) => (line.dateFilled === null || r.dateFilled === line.dateFilled) && (line.ndc11 === null || r.ndc11 === line.ndc11),
    (r) => nearDate(r) && (line.ndc11 === null || r.ndc11 === line.ndc11),
    (r) => nearDate(r),
  ];
  return levels;
}

/** Where the Medicare Transaction Facilitator's money comes from, as `claim_payments.source` names it. */
const FACILITATOR = "mtf";

/**
 * What a line's source is expected to pay on a claim, as the claim itself says: its remit, for a plan; for the facilitator, the refund
 * the claim promised. The facilitator pays no remit, so a claim whose remit happens to equal a refund says nothing about whose refund it
 * is. Null where the claim says nothing, which equals no amount.
 */
const expectedOn = (r: ClaimCandidate, line: RemittanceLine): number | null => (line.source === FACILITATOR ? (r.facilitatorCents ?? null) : r.remitCents);

/**
 * The claims a take-back can be reversing. A plan pays a claim and later takes the money back, and the line names the fill and nothing
 * that says which of two claims it is. Its amount is the opposite of what the claim was paid, so the amount rule can never single a
 * claim out; what can is the claim itself: one whose remit (for the facilitator, its promised refund) is exactly the amount taken back,
 * that already holds a payment of exactly that amount from the same source, and that has not been taken back for it already (what it
 * holds is still at least the amount).
 *
 * Measured 5 October 2026 over every take-back in the books that fits two or more claims: 6 of the 13, -$434.40 in all, meet every
 * condition, each on exactly one claim. Those 6 are on five claims, each paid its remit two or three times over, and each is paid exactly
 * its remit once they are counted. Each of the other 7 is one half of a payment and take-back that are both tied to nothing, and none
 * of them is the amount of a remit, so none is tied. `partnerWaiting` is for a case the data has not shown yet: such a pair, on a fill
 * where another claim also holds a payment of that amount.
 */
function claimsTakenBackFrom(pool: ClaimCandidate[], line: RemittanceLine): ClaimCandidate[] {
  if (line.amountCents === null || line.amountCents >= 0 || line.partnerWaiting) return [];
  const back = -line.amountCents;
  return pool.filter((r) => {
    if (expectedOn(r, line) !== back) return false;
    const mine = (r.tied ?? []).filter((t) => t.source === line.source);
    return mine.some((t) => t.amountCents === back) && mine.reduce((n, t) => n + t.amountCents, 0) >= back;
  });
}

/** What the line's amount did and did not settle, in the words a list of import problems reads aloud. */
function amountClause(line: RemittanceLine, paidThis: number, takenBack: number): string {
  if (line.amountCents === null) return " and gives no amount to match on";
  if (line.amountCents >= 0 && line.source === FACILITATOR) {
    return paidThis > 1 ? ` and ${paidThis} of them promise exactly this refund` : " and none of them promises exactly this refund";
  }
  if (line.amountCents >= 0) return paidThis > 1 ? ` and ${paidThis} of them were paid exactly this amount` : " and none of them was paid exactly this amount";
  if (line.partnerWaiting) return " and it takes back a payment of the same amount for this fill that is itself waiting to be attached, so the two cancel";
  return takenBack > 1
    ? ` and it takes money back, and ${takenBack} of them were paid exactly that amount in full by this source`
    : " and it takes money back, and none of them was paid exactly that amount in full by this source";
}

/**
 * The claim a remittance line settles, or nothing and the reason.
 *
 * `candidates` is every *paid* claim on the prescription. Reversed rows are not offered here: a
 * payment against a claim that was reversed is a different problem, and the caller reports it.
 */
export function chooseClaimForRemittance(candidates: ClaimCandidate[], line: RemittanceLine): Choice {
  if (candidates.length === 0) return { claim: null, ambiguous: null };

  for (const fits of levelsFor(line)) {
    const hits = candidates.filter(fits);
    if (hits.length === 0) continue;
    if (hits.length === 1) return { claim: hits[0], ambiguous: null };

    /*
     * More than one claim on the same prescription, fill, day and drug means a fill billed to more
     * than one payer. The payer is what tells them apart, so ask which payer this money is from.
     */
    /*
     * A voucher programme pays a claim that carries a voucher, and never the other row of a
     * coordinated fill. Asked before the BIN, because the BIN is often the one thing their file
     * does not print.
     */
    const byVoucher = line.fromProgramme ? hits.filter((r) => r.carriesVoucher) : [];
    if (byVoucher.length === 1) return { claim: byVoucher[0], ambiguous: null };

    const from = byVoucher.length > 1 ? byVoucher : hits;
    const byBin = line.bin ? from.filter((r) => digits(r.bin) === digits(line.bin)) : [];
    if (byBin.length === 1) return { claim: byBin[0], ambiguous: null };
    const pool = byBin.length > 1 ? byBin : from;

    const byAmount = line.amountCents === null ? [] : pool.filter((r) => expectedOn(r, line) === line.amountCents);
    if (byAmount.length === 1) return { claim: byAmount[0], ambiguous: null };

    const byTakeBack = claimsTakenBackFrom(pool, line);
    if (byTakeBack.length === 1) return { claim: byTakeBack[0], ambiguous: null };

    return {
      claim: null,
      ambiguous: {
        count: pool.length,
        why:
          `${pool.length} paid claims on this prescription match the line equally well` +
          `${line.bin ? "" : " and the remittance does not name a payer BIN"}` +
          amountClause(line, byAmount.length, byTakeBack.length) +
          ". The site will not guess: choose the claim it paid on the Payments with no claim page.",
      },
    };
  }

  return { claim: null, ambiguous: null };
}

/** The claims of `candidates` that are for the fill a line is paying, at the strictest level that finds any; none where none is. */
export function claimsOfThisFill<T extends ClaimCandidate>(candidates: T[], line: RemittanceLine): T[] {
  for (const fits of levelsFor(line)) {
    const hits = candidates.filter(fits);
    if (hits.length > 0) return hits;
  }
  return [];
}

/** A claim row on the prescription as the site holds it, paid or reversed. */
export type ClaimOnFile = ClaimCandidate & {
  status: "paid" | "reversed";
  /** The day the prescription was completed (sold), from the export; null where it never was. */
  soldOn: string | null;
};

/**
 * What the site makes of one payment, given every claim it holds for the prescription: the answer `findClaim` acts on,
 * with the reason where the answer is no claim. Pure, so that the screen which explains an unattached payment and the
 * matcher which left it unattached read the same claims the same way.
 */
export type Verdict =
  | { kind: "tied"; claim: ClaimOnFile }
  | { kind: "no_claim_on_file" }
  /** The site holds claims for the prescription and not one is paid. `fill` is those of them that are for this fill: none, where they are all for other fills. */
  | { kind: "only_reversed"; fill: ClaimOnFile[] }
  | { kind: "ambiguous"; count: number; why: string }
  /** The site holds paid claims for the prescription and none fits this fill. `reversedFill` is the reversed claims that do, if any. */
  | { kind: "no_fit"; reversedFill: ClaimOnFile[] };

export function verdictOnPrescription(onFile: ClaimOnFile[], line: RemittanceLine): Verdict {
  if (onFile.length === 0) return { kind: "no_claim_on_file" };
  const paid = onFile.filter((r) => r.status === "paid");
  if (paid.length === 0) return { kind: "only_reversed", fill: claimsOfThisFill(onFile, line) };
  const chosen = chooseClaimForRemittance(paid, line);
  const claim = chosen.claim ? paid.find((r) => r.id === chosen.claim!.id) : undefined;
  if (claim) return { kind: "tied", claim };
  if (chosen.ambiguous) return { kind: "ambiguous", ...chosen.ambiguous };
  return { kind: "no_fit", reversedFill: claimsOfThisFill(onFile.filter((r) => r.status === "reversed"), line) };
}
