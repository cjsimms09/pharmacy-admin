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

/**
 * Every amount printed against a label with a minus sign: "DISCOUNT-1.22", "DISCOUNT -1.22" or "DISCOUNT(1.22)".
 * Returned as positive cents; the sign is the label's meaning, not the number's.
 */
function labelledOff(text: string, label: RegExp): number[] {
  const found: number[] = [];
  for (const row of text.split(/\r?\n/).map((r) => r.trim())) {
    const m = new RegExp(`^${label.source}\\s*[-(]\\s*(${MONEY})\\)?$`, "i").exec(row);
    if (m) found.push(cents(m[1]));
  }
  return found;
}

export type DiscountRead = {
  /** Positive: the amount taken off. */
  discountCents: number;
  /** The sales tax printed alongside it, where the gap is only explained by both; zero otherwise. */
  taxCents: number;
  says: string;
};

/**
 * The discount ParMed prints after its subtotal, and why reading it takes the same three figures agreeing as tax.
 *
 * ParMed invoice 7492505037 of 21 September 2026: one line, 121.71, SUB TOTAL 121.71, DISCOUNT-1.22, GRAND TOTAL 120.49. The
 * reader knew about tax and nothing about discount, so the line sum sat above the invoice total and nothing said so, and the
 * price check set the line's 121.71 against the 120.48 PioneerRx booked in (the price after discount) and put "$1.23 more than
 * arrived" on the screen about an invoice that was right. A second, $0.41 on 5 October, did the same.
 *
 * Taken only when the invoice prints a subtotal equal to what was read, exactly one labelled discount, and that discount
 * accounts for the whole gap to the cent (alone, or against exactly one labelled tax). Anything else is null: a number beside
 * a word is not a proof.
 */
export function discountOnInvoice(
  text: string,
  lineSumCents: number,
  printedTotalCents: number | null,
  otherChargesCents = 0,
): DiscountRead | null {
  if (printedTotalCents === null || lineSumCents <= 0) return null;
  const gap = printedTotalCents - lineSumCents - otherChargesCents;
  if (gap === 0) return null;
  if (!labelled(text, /sub\s*total/).some((s) => s === lineSumCents)) return null;
  const off = labelledOff(text, /discount/);
  if (off.length !== 1) return null;
  const d = off[0];
  const f = (c: number) => (c / 100).toFixed(2);
  if (gap === -d) {
    return {
      discountCents: d,
      taxCents: 0,
      says: `Discount ${f(d)}: the invoice prints a subtotal of ${f(lineSumCents)}, which is what its item lines come to, takes ${f(d)} off, and totals ${f(printedTotalCents)}.`,
    };
  }
  const taxes = labelled(text, /tax/).filter((t) => t - d === gap);
  if (taxes.length !== 1) return null;
  return {
    discountCents: d,
    taxCents: taxes[0],
    says: `Discount ${f(d)} and sales tax ${f(taxes[0])} after a subtotal of ${f(lineSumCents)}, totalling ${f(printedTotalCents)}.`,
  };
}

/**
 * Whether price differences on one invoice are the discount the invoice prints.
 *
 * PioneerRx books a delivery at the price after discount, so the invoice's line price is above it by the discount, spread over
 * the lines it applied to. The differences explain the discount when they add up to it, within a cent a line for rounding.
 */
export function pricesExplainedByDiscount(differencesCents: number[], discountCents: number): boolean {
  if (differencesCents.length === 0 || discountCents <= 0) return false;
  if (differencesCents.some((d) => d <= 0)) return false;
  const sum = differencesCents.reduce((n, d) => n + d, 0);
  return Math.abs(sum - discountCents) <= differencesCents.length;
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
