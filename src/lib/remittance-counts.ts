/*
 * What the payments of one remittance are, kind by kind, for the lines that say so once it is read: the intake summary
 * and the mailbox line.
 *
 * `importRemittance` counts each payment it posts into exactly one of five kinds, so the numbers spoken here add to the
 * payments counted and none is left to be read as a failure, or as a wait. The lines used to say the one kind they did
 * not understand was "waiting for theirs": a payment for a line that names no drug and no fill is waiting for no claim,
 * and one that fits two claims has claims. This says what the importer knows (it matched, or it did not) and nothing it
 * does not; why a payment is tied to none is the matcher's answer on Claims, Payments with no claim.
 *
 * Pure.
 */

export type RemittanceKinds = {
  matched: number;
  /** For fills from before the records begin: no claim here to match, counted apart so a September fill that ought to match is not hidden among them. */
  beforeTheStart: number;
  unmatched: number;
  paidAReversedFill: number;
  ambiguous: number;
};

export function remittanceKindsSay(k: RemittanceKinds): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    `${n(k.matched)} matched to a claim`,
    k.beforeTheStart ? `${n(k.beforeTheStart)} for fills from before this site's records begin` : "",
    k.unmatched ? `${n(k.unmatched)} tied to no claim` : "",
    k.paidAReversedFill ? `${n(k.paidAReversedFill)} paid against a fill this pharmacy had reversed` : "",
    k.ambiguous ? `${n(k.ambiguous)} that ${k.ambiguous === 1 ? "fits" : "fit"} two or more claims equally` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
