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
 *    what this payer paid. A claim whose own remit equals it is the claim being settled.
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
};

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
};

export type Choice = {
  claim: ClaimCandidate | null;
  /** Set where candidates were found but none could be singled out. Never silent. */
  ambiguous: { count: number; why: string } | null;
};

const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");

/**
 * The claim a remittance line settles, or nothing and the reason.
 *
 * `candidates` is every *paid* claim on the prescription. Reversed rows are not offered here: a
 * payment against a claim that was reversed is a different problem, and the caller reports it.
 */
export function chooseClaimForRemittance(candidates: ClaimCandidate[], line: RemittanceLine): Choice {
  if (candidates.length === 0) return { claim: null, ambiguous: null };

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

  for (const fits of levels) {
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

    const byAmount = line.amountCents === null ? [] : pool.filter((r) => r.remitCents === line.amountCents);
    if (byAmount.length === 1) return { claim: byAmount[0], ambiguous: null };

    return {
      claim: null,
      ambiguous: {
        count: pool.length,
        why:
          `${pool.length} paid claims on this prescription match the line equally well` +
          `${line.bin ? "" : " and the remittance does not name a payer BIN"}` +
          `${line.amountCents === null ? " and gives no amount to match on" : byAmount.length > 1 ? ` and ${byAmount.length} of them were paid exactly this amount` : " and none of them was paid exactly this amount"}` +
          ". Attach it to the right one by hand rather than have the site guess.",
      },
    };
  }

  return { claim: null, ambiguous: null };
}
