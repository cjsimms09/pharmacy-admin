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

/**
 * Whether two names are the same wholesaler.
 *
 * Different question from `rateForSupplier` above, which matches a printed name to a key in a table
 * the pharmacy keyed itself. This compares two names that both came off documents, and it exists
 * because the invoice proof shipped without it and was wrong on every line it reported.
 *
 * On 14 September the proof reported ten invoices "filed under a different wholesaler than the page
 * now names", and all ten were one wholesaler written two ways: nine filed IPC against pages reading
 * "Independent Pharmacy Cooperative", and one filed IPD against "Independent Pharmacy Distributor".
 * The check was comparing a filing shorthand with a printed legal name and calling it a different
 * company. Worse than useless: a real ParMed-filed-under-Cardinal would have been indistinguishable
 * from the noise.
 *
 * Three rules, and the third is the one that was missing:
 *
 *   A name nobody recorded cannot disagree with anything, so a null on either side agrees.
 *
 *   One name being a prefix of the other is the same company written longer — "ParMed" against
 *   "PARMED PHARMACEUTICALS" — and the prefix must be at least `SHORTEST_MATCH` characters, for the
 *   reason given above: short strings appear inside unrelated names often enough to be a coin toss.
 *
 *   An acronym against its own expansion is the same company. "IPC" is the initials of "Independent
 *   Pharmacy Cooperative" and that is a fact about the two strings rather than an alias somebody has
 *   to remember to add — an alias list is a list that goes stale the first time a wholesaler is
 *   added by somebody who does not know it exists.
 *
 * Deliberately not a similarity score. Either these are the same company or they are not, and a
 * threshold would make the answer depend on a number nobody can defend.
 */
export function sameWholesaler(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length >= SHORTEST_MATCH && long.startsWith(short)) return true;
  return initialsOf(a) === y || initialsOf(b) === x;
}

const fold = (v: string | null | undefined): string => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The initials of a multi-word name, or "" where there are not enough words to form any.
 *
 * Two words at minimum, and each has to be a word rather than a stray letter, so "J M Smith" does
 * not collapse to something that matches half the register.
 */
function initialsOf(v: string | null | undefined): string {
  const words = (v ?? "").split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 2);
  if (words.length < 2) return "";
  return words.map((w) => w[0]).join("").toUpperCase();
}
