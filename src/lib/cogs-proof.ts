/**
 * Cost of goods, proved a second way — from documents the pharmacy did not compute.
 *
 * ── Why this exists ──
 *
 * The owner, 17 September 2026, after a day in which four money faults were found and he found two
 * of them first: "DO YOU TRUST THE MONEY AS EXECUTIVE OF THIS COMPANY.. DOES THIS PAGE NEED A DEEP
 * AUDIT, IF SO HOW?"
 *
 * No, and yes. Every fault that day was in a figure with exactly one route to it: a rate, an
 * estimate, a total nothing else had an opinion about. A number nothing disagrees with is a number
 * nobody is checking, and the largest such number on the books is the acquisition cost of what was
 * dispensed — $269,984.50 for September, computed from the claims and from nothing else.
 *
 * ── The second route ──
 *
 * The claims say what left the shelf, priced per bottle. The wholesalers' invoices say what arrived,
 * and PioneerRx's Balance on Hand says what the shelf was worth on a given morning. Those three are
 * a different measurement of the same thing:
 *
 *     cost of what was dispensed  =  purchases  +  opening stock  −  closing stock
 *
 * Nothing in that identity comes from the claims, which is the whole point: it can disagree.
 *
 * ── Why this is a reconciliation and not a pass mark ──
 *
 * The two routes price the same bottle differently — the claims carry the acquisition cost recorded
 * at the fill, the shelf carries PioneerRx's unit cost at the count — so a gap of some size is
 * expected and is not evidence of anything. Inventing a tolerance here would be inventing the
 * finding, so this refuses to: it states both routes, states the gap, and names the reasons a
 * legitimate gap exists.
 *
 * What it will call wrong is an **impossible** gap: one larger than the whole of the purchases it is
 * being reconciled against. Two measurements of one quantity cannot differ by more than one of them
 * entirely unless a term is wrong, and that judgement needs no threshold anybody made up.
 *
 * ── What it refuses to answer ──
 *
 * A shelf valuation is a snapshot of a morning, so the identity needs one at each end of the window.
 * Where either is absent the answer is not zero and not an assumption: it is that the question
 * cannot be asked yet, and which snapshot is missing. Balance on Hand has only arrived daily since
 * 11 September 2026, so September cannot be proved from the 1st — and saying so is the finding.
 *
 * Pure.
 */

export type CogsTerms = {
  /** The window being proved, inclusive. */
  from: string;
  to: string;
  /** Route one: the acquisition cost of everything dispensed, from the claims. Null if none loaded. */
  claimsCogsCents: number | null;
  /** Route two, first term: what the wholesalers billed for goods in the window. */
  purchasesCents: number | null;
  /** The shelf valuation at each end, and the day each was actually counted. */
  openingCents: number | null;
  openingOn: string | null;
  closingCents: number | null;
  closingOn: string | null;
  /**
   * Lines in each snapshot, and the usual number.
   *
   * A Balance on Hand that arrived truncated values a shelf that is not there. The counts on file
   * for 11–17 September run from 1,767 to 2,252 — a fifth of the shelf — so a snapshot has to be
   * able to say it is not whole, or the proof quietly reconciles against a partial count.
   */
  openingLines: number | null;
  closingLines: number | null;
  typicalLines: number | null;
};

export type CogsProof = {
  /** Null where the term is not there; the reason is in `cannot`. */
  claimsCents: number | null;
  documentsCents: number | null;
  gapCents: number | null;
  /** The gap as a share of the claims figure, for reading rather than for judging. */
  gapPercent: number | null;
  /** True only where both routes exist AND the gap is not impossible. */
  ok: boolean;
  /** Why it could not be asked, where it could not. Empty when both routes were computed. */
  cannot: string[];
  /** What a reader should know before drawing a conclusion from the gap. */
  caveats: string[];
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A snapshot missing more than a tenth of its usual lines is not a whole count of the shelf. */
const PARTIAL_SHARE = 0.9;

export function proveCogs(t: CogsTerms): CogsProof {
  const cannot: string[] = [];
  const caveats: string[] = [];

  if (t.claimsCogsCents === null) cannot.push("No claims are loaded for this window, so there is no cost of goods to prove.");
  if (t.purchasesCents === null) cannot.push("No supplier invoices are on file for this window, so what arrived cannot be totalled.");
  if (t.openingCents === null) cannot.push(`No shelf valuation on or before ${t.from}, so what the shelf was worth at the start is not known.`);
  if (t.closingCents === null) cannot.push(`No shelf valuation on or before ${t.to}, so what the shelf was worth at the end is not known.`);

  /* Said whether or not the proof runs: a caveat that only appears on failure is a caveat nobody reads. */
  if (t.openingOn && t.openingOn !== t.from) caveats.push(`The opening shelf was counted on ${t.openingOn}, not ${t.from}.`);
  if (t.closingOn && t.closingOn !== t.to) caveats.push(`The closing shelf was counted on ${t.closingOn}, not ${t.to}.`);

  /*
   * A partial count refuses the question; it does not qualify the answer.
   *
   * This began as a caveat under the figure, and that was wrong. A Balance on Hand that arrived
   * truncated values a shelf that was not there, and the identity has no way to tell a bottle that
   * was dispensed from a bottle whose line did not arrive — so the gap it produces is not a smaller
   * or larger version of the truth, it is a number about a different shelf. Reconciling against it
   * and printing a caveat underneath is how a figure nobody can trust ends up being quoted.
   *
   * The counts on file for 11–17 September 2026 run from 1,767 lines to 2,252 against a usual 2,046.
   * That the feed does this at all is the first thing to fix, and saying so plainly is more use than
   * an answer computed over it.
   */
  if (t.typicalLines !== null) {
    const thin = (n: number | null, which: string, on: string | null) => {
      if (n === null) return;
      if (n < t.typicalLines! * PARTIAL_SHARE) {
        cannot.push(
          `The ${which} shelf count${on ? ` of ${on}` : ""} has ${n.toLocaleString()} lines against a usual ${t.typicalLines!.toLocaleString()}, so it is not a whole shelf and nothing can be reconciled against it.`,
        );
      }
    };
    thin(t.openingLines, "opening", t.openingOn);
    thin(t.closingLines, "closing", t.closingOn);
  }
  caveats.push(
    "The two routes price a bottle differently — the claims at the acquisition cost recorded when it was filled, the shelf at PioneerRx's unit cost when it was counted — so a gap of some size is expected and is not by itself a fault.",
  );

  if (cannot.length > 0) {
    return {
      claimsCents: t.claimsCogsCents,
      documentsCents: null,
      gapCents: null,
      gapPercent: null,
      ok: false,
      cannot,
      caveats,
      says: cannot[0],
    };
  }

  const claimsCents = t.claimsCogsCents!;
  const documentsCents = t.purchasesCents! + t.openingCents! - t.closingCents!;
  const gapCents = claimsCents - documentsCents;
  const gapPercent = claimsCents === 0 ? null : Math.round((gapCents / claimsCents) * 1000) / 10;

  /*
   * The only judgement made here, and it needs no invented number.
   *
   * Two measurements of one quantity cannot differ by more than the whole of the purchases being
   * reconciled unless one of the terms is wrong — a snapshot valuing a different shelf, invoices
   * counted into the wrong window, a cost basis that is not a cost.
   */
  const impossible = Math.abs(gapCents) > Math.abs(t.purchasesCents!);

  return {
    claimsCents,
    documentsCents,
    gapCents,
    gapPercent,
    ok: !impossible,
    cannot: [],
    caveats,
    says:
      `The claims say ${money(claimsCents)} of goods was dispensed. The documents say ${money(documentsCents)} — ` +
      `${money(t.purchasesCents!)} bought, plus a shelf worth ${money(t.openingCents!)} at the start, less ${money(t.closingCents!)} at the end. ` +
      (gapCents === 0
        ? "They agree to the cent."
        : `They differ by ${money(Math.abs(gapCents))}${gapPercent === null ? "" : ` (${Math.abs(gapPercent)}% of the claims figure)`}, the claims being the ${gapCents > 0 ? "higher" : "lower"}.`) +
      (impossible
        ? " That is larger than everything bought in the window, which no difference in cost basis can account for: one of the three terms is wrong."
        : ""),
  };
}
