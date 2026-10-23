/**
 * One payer, however its name was typed.
 *
 * August's remittances arrived from "EXPRESS SCRIPTS INC" and "EXPRESS SCRIPTS INC." — the same
 * company, differing by a full stop, and counted as two payers worth $37,438.32 and $3,867.12. Every
 * report that groups by payer would have split them, and the smaller one looks like a minor payer
 * nobody need think about rather than part of a major one.
 *
 * ── Why this is deliberately timid ──
 *
 * The obvious next step is to drop corporate suffixes, so that "Acme Health" and "Acme Health Inc"
 * agree. That is how two genuinely different companies get merged — "Smith Pharmacy" and "Smith
 * Pharmacy Services Inc" are not always the same payer, and a wrongly merged payer is far harder to
 * notice than a wrongly split one: the money still adds up, it is just attributed to the wrong
 * counterparty, and no total ever disagrees.
 *
 * So this normalises only what cannot carry meaning: punctuation, spacing and case. A name that
 * still differs after that is treated as a different payer, and if two such names turn out to be one
 * company, that is a fact somebody has to assert rather than something to infer from spelling.
 */

/**
 * The comparable form of a payer's name.
 *
 * Punctuation removed, runs of whitespace collapsed, upper-cased. Empty in, empty out — a payer with
 * no name is not the same payer as every other payer with no name, and the caller decides what to do
 * about that.
 */
export function normalisePayerName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    /*
     * Ampersands become "AND" rather than being stripped.
     *
     * "SS&C HEALTH" and "SS C HEALTH" would otherwise differ only by a space that stripping had
     * introduced, which is the same bug in the other direction.
     */
    .replace(/&/g, " AND ")
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Whether two printed names are the same payer, by the rule above. */
export function samePayer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalisePayerName(a);
  const y = normalisePayerName(b);
  return x.length > 0 && x === y;
}

/**
 * The name to show for a payer seen under several spellings.
 *
 * The longest one, because the differences are punctuation and truncation, and the longest is the
 * one that was not cut short. "EXPRESS SCRIPTS INC." beats "EXPRESS SCRIPTS INC"; a bank statement's
 * "RXCROSSROADS BY" loses to the portal's "RxCrossroads by McKesson".
 *
 * Ties go to the first seen, so the result does not depend on the order a set happened to iterate.
 */
export function bestPayerName(names: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const n of names) {
    const t = (n ?? "").trim();
    if (!t) continue;
    if (best === null || t.length > best.length) best = t;
  }
  return best;
}
