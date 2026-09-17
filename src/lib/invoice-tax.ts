/**
 * The sales tax a wholesaler adds after its subtotal, and why reading it takes three numbers agreeing.
 *
 * ── What went wrong ──
 *
 * ParMed invoice of 16 September 2026: nine item lines, every extension exactly quantity × unit
 * price, summing to $291.03. The invoice's total is $292.18, so the site reported it $1.15 short and
 * could say nothing about where the $1.15 had gone. Nothing had gone anywhere. The invoice prints
 * SUB TOTAL 291.03, then TAX 1.15, then GRAND TOTAL 292.18, and the reader compared item lines
 * against the grand total while knowing nothing about tax.
 *
 * Two costs, and the second is the one that lasts. An invoice read correctly is reported as a
 * discrepancy, so the list of invoices that do not balance fills with invoices that do — and a list
 * like that stops being read. And the tax itself is a real cost of the purchase that was booked
 * nowhere.
 *
 * ── Why it is not simply "find the word TAX" ──
 *
 * The amount sits inside ParMed's legend block, between "6 TEMPORARILY OUT" and "OV OVERRIDE",
 * because the PDF's columns interleave when flattened to text. Anything that goes looking for a
 * label near a number in that block will eventually find the wrong number, and the way that failure
 * shows up is a drug's cost quietly carrying somebody's tax.
 *
 * So the amount is never taken on the strength of the label. It is taken on the strength of the
 * arithmetic: the invoice must print a subtotal that equals what was read off its item lines, and
 * the labelled tax must equal exactly what is left between that subtotal and the printed total.
 * Three printed figures and the reading all agreeing is a proof; a label next to a number is a
 * guess. This is the same rule the Rx Systems reader works under, and the same reason.
 *
 * Pure. Nothing here stores anything.
 */

const MONEY = String.raw`[\d,]+\.\d{2}`;
const cents = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

/**
 * Every amount printed against a label, where the label may be joined to the number or sit just
 * before it — "TAX1.15", "TAX 1.15", and "SUB TOTAL" on its own line above "291.03" all read.
 */
function labelled(text: string, label: RegExp): number[] {
  const rows = text.split(/\r?\n/).map((r) => r.trim());
  const found: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = new RegExp(`^${label.source}\\s*(${MONEY})$`, "i").exec(rows[i]);
    if (m) {
      found.push(cents(m[1]));
      continue;
    }
    /* The label alone, with its figure on the next line — how ParMed prints its subtotal and total. */
    if (new RegExp(`^${label.source}$`, "i").test(rows[i])) {
      const next = rows[i + 1] ?? "";
      const n = new RegExp(`^(${MONEY})$`).exec(next);
      if (n) found.push(cents(n[1]));
    }
  }
  return found;
}

export type TaxRead = {
  amountCents: number;
  /** Said in full, because this is a figure that changes whether an invoice balances. */
  says: string;
};

/**
 * The tax on an invoice, or null — and null far more often than not, by design.
 *
 * @param lineSumCents what the item lines actually read came to
 * @param printedTotalCents the total printed on the face of the invoice
 * @param otherChargesCents freight and the like already read off it, which the subtotal excludes
 */
export function salesTaxOnInvoice(
  text: string,
  lineSumCents: number,
  printedTotalCents: number | null,
  otherChargesCents = 0,
): TaxRead | null {
  if (printedTotalCents === null || lineSumCents <= 0) return null;
  const gap = printedTotalCents - lineSumCents - otherChargesCents;
  if (gap <= 0) return null;

  /*
   * The subtotal has to be printed, and has to agree with what was read.
   *
   * Without it there is a gap and a number, and no way to tell a tax line from a line the reader
   * missed that happens to cost the same. With it, the invoice itself has said the item lines are
   * complete — and then the only thing the gap can be is what is printed after the subtotal.
   */
  const subtotals = labelled(text, /sub\s*total/);
  if (!subtotals.some((s) => s === lineSumCents)) return null;

  /*
   * Exactly one labelled tax, and it accounts for the gap to the cent. Two candidates matching is
   * refused as readily as none: a document that prints the figure twice in two senses is a document
   * this has not understood.
   */
  const matches = labelled(text, /tax/).filter((t) => t === gap);
  if (matches.length !== 1) return null;

  return {
    amountCents: gap,
    says:
      `Sales tax ${(gap / 100).toFixed(2)}: the invoice prints a subtotal of ${(lineSumCents / 100).toFixed(2)}, which is what its ` +
      `item lines come to, and a total of ${(printedTotalCents / 100).toFixed(2)}. The difference is printed as tax.`,
  };
}
