/**
 * A bill's own printed total, taken only where the page proves it.
 *
 * The owner, 25 September 2026, on being asked to confirm the PioneerRx bill: "why do I need to
 * confirm it". The honest answer was that the sweep never read the amount — it files a draft at the
 * vendor's typical figure, because reading a total off an arbitrary vendor's PDF is a guess with a
 * number attached, and a guess that walks into the month's profit is worse than no figure.
 *
 * That reasoning is about unproven totals, not about totals. A page that prints a subtotal, a tax
 * and a total which add up has done the arithmetic in front of you, and there is nothing left to
 * agree with. So this reads those three and returns a figure only when they reconcile exactly.
 *
 * ── Why it refuses rather than falls back ──
 *
 * Every other outcome is a guess: a total with no subtotal to check it, two candidate totals, a
 * page where the sums are a penny out because a column was misread. Each of those is precisely the
 * case the draft exists for, and each returns null here so the draft still happens. The only thing
 * this removes is the confirmation nobody could add anything to.
 *
 * Pure: text in, cents out. It knows no vendor, so any bill whose page proves itself is read.
 */

export type ProvenTotal = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** The words the page used, so the figure can be argued with rather than only trusted. */
  says: string;
};

const CENTS = String.raw`\$?\s*([\d,]+\.\d{2})`;
const cents = (s: string): number => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);

/**
 * Every amount the page gives a named label, as cents.
 *
 * The labels run straight onto their figures on a real invoice — "Sub Total$2,130.69" — and on
 * others they are separated by spaces or a line break, so the gap is optional and a newline counts.
 * The last match of a label wins: a page that prints its totals twice, once per page, means the
 * second is the one that closes the document.
 */
function labelled(text: string, label: RegExp): number | null {
  const re = new RegExp(label.source + String.raw`\s*:?\s*` + CENTS, "gi");
  let found: number | null = null;
  for (const m of text.matchAll(re)) found = cents(m[1]);
  return found;
}

export function readPrintedBillTotal(text: string): ProvenTotal | null {
  const subtotal = labelled(text, /sub\s*-?\s*total/);
  const total = labelled(text, /(?<!sub\s)(?<!sub-)\btotal/);
  if (subtotal === null || total === null) return null;

  /*
   * No tax line is nought rather than unknown: a bill that prints a subtotal and a total and no tax
   * is one where they are the same figure, and that is checked below like any other.
   */
  const tax = labelled(text, /\btax\b/) ?? 0;

  if (subtotal + tax !== total) return null;
  /* A total of nought proves nothing and is not a bill anybody needs booked. */
  if (total === 0) return null;

  return {
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: total,
    says: `The page prints a subtotal of ${(subtotal / 100).toFixed(2)}, tax of ${(tax / 100).toFixed(2)} and a total of ${(total / 100).toFixed(2)}, and they add up.`,
  };
}
