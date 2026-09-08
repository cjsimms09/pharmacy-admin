/**
 * Matching the name a price file gives a wholesaler to the name the register holds for it.
 *
 * The two are rarely identical. A catalogue header says "MCKESSON CONNECT", the register says
 * "McKesson", an invoice says "McKesson Corporation". Something has to reconcile them, because
 * what hangs on it is the rebate rate — and the rate is what decides which wholesaler the site
 * says to buy from. Getting it wrong is not a display fault.
 *
 * Two rules, both learned from what goes wrong without them:
 *
 * The most specific match wins, not the first one found. Iterating an object and returning the
 * first containment hit makes the answer depend on the order rates were entered in, and lets a
 * short registered name swallow a longer one — with both "smith" and "smith drug co" on file,
 * whichever was recorded first decided the rate.
 *
 * And a containment match has to be at least four characters. Two- and three-letter names appear
 * inside unrelated company names often enough that the test alone is a coin toss, and a wrong rate
 * is worse than no rate: no rate understates the pharmacy's position, which is the safe direction
 * to be wrong in.
 *
 * Pure, so the ledger and the drug file can never disagree about which wholesaler a rate belongs to.
 */

/** The shortest containment match worth trusting. */
export const SHORTEST_MATCH = 4;

/**
 * The rate on file for this supplier, or null where none is.
 *
 * Keys are expected already lowercased, as every caller stores them. Null is a real answer and
 * means "nothing is known", never "nothing is earned".
 */
export function rateForSupplier<T>(rates: Record<string, T>, supplier: string | null | undefined): T | null {
  if (!supplier) return null;
  const a = supplier.trim().toLowerCase();
  if (!a) return null;
  if (Object.prototype.hasOwnProperty.call(rates, a)) return rates[a];

  let bestName = "";
  let best: T | null = null;
  for (const [name, value] of Object.entries(rates)) {
    if (name.length < SHORTEST_MATCH) continue;
    if (!(a.includes(name) || name.includes(a))) continue;
    if (name.length > bestName.length) {
      bestName = name;
      best = value;
    }
  }
  return best;
}
