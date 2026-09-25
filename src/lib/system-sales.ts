/**
 * The System Sales Summary: the whole till for a month, retail alongside prescriptions.
 *
 * The only report the pharmacy has that answers "what did we take". The transaction report cannot:
 * it is dispensing only, so reading it as total revenue understates the business by everything sold
 * over the counter — on one real month, $5,458.88 of it. And it is drawn by the day a claim was
 * transmitted, which is not the day the money arrived.
 *
 * This one is drawn by the month and separates the three things that are genuinely different:
 *
 *   what patients handed over          $93,259.56
 *   what the plans remitted           $570,778.94
 *   what the front of shop sold         $5,458.88
 *
 * Returns are already in it and already negative — $117,906.54 across that month, which is not a
 * rounding matter and is why the sales column and the total column are both kept rather than one
 * being derived from the other.
 *
 * Pure, so a month can be checked against the printed page by hand.
 */

/** "5760.42", "-656.02", "380.8665" — plain numbers, no currency, sometimes four decimals. */
export function salesCents(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim().replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export type SalesRow = {
  /** The heading this row was printed under: "Retail Sales", "Rx Plan Third Party Remit", … */
  section: string;
  label: string;
  salesCents: number | null;
  discountsCents: number | null;
  returnsCents: number | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  kind: "line" | "subtotal" | "total";
};

export type SystemSales = {
  period: { from: string; to: string } | null;
  /** The month it covers, as YYYY-MM, where the period sits inside one. */
  month: string | null;
  printedOn: string | null;
  rows: SalesRow[];
  /**
   * Over the counter, before sales tax: the part of the business the transaction report cannot see
   * at all. The report's Total column carries the tax collected on top; that is Kansas's money,
   * held for it, and it was being counted as revenue.
   */
  retailCents: number | null;
  /** Sales tax collected on retail, from the report's Tax column. A liability, never revenue. */
  retailTaxCents: number | null;
  /** What patients paid at the till for prescriptions. */
  rxPatientCents: number | null;
  /** What the plans remitted. */
  rxRemitCents: number | null;
  rxCents: number | null;
  /** Everything, which is the figure to reconcile against the bank. */
  totalCents: number | null;
  problems: string[];
};

export const SALES_TITLE = "System Sales Summary";

export function looksLikeSystemSales(text: string, fileName = ""): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  return head.includes(SALES_TITLE) || /accrual[_ -]*system[_ -]*sales/i.test(fileName);
}

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const iso = (s: string): string | null => {
  const m = MDY.exec(s.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/*
 * The headings, in the order they nest.
 *
 * "Rx Plan Customer Payments" and "Rx Plan Third Party Remit" sit inside "Rx Sales", and both carry
 * a row called "Medicare Part D" — so a row's label alone does not identify it and the heading it
 * was printed under has to be carried with it. Reading them as one list would add $108,701.75 of
 * plan remittance to $8,813.73 of patient payment under a single name and call it Part D.
 */
const SECTIONS = [
  "Retail Sales",
  "Rx Sales",
  "Rx Plan Customer Payments",
  "Rx Plan Third Party Remit",
  "Sales Adjustments",
  "Other",
];

export function parseSystemSales(text: string): SystemSales {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const rows: SalesRow[] = [];
  const problems: string[] = [];
  let period: SystemSales["period"] = null;
  let printedOn: string | null = null;
  let section = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const printed = /^Printed On:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(line);
    if (printed) {
      printedOn = iso(printed[1]);
      continue;
    }

    // "8/1/2026 - 8/31/2026", the period, which is the only line shaped like two dates.
    const per = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/.exec(line);
    if (per) {
      const from = iso(per[1]);
      const to = iso(per[2]);
      if (from && to) period = { from, to };
      continue;
    }

    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

    // A heading: one cell, and one this report is known to print.
    if (cells.length === 1) {
      if (SECTIONS.includes(cells[0])) section = cells[0];
      continue;
    }

    const label = cells[0];
    if (!label) continue;
    // The column header, and the wrapped "Amount,Amount,Amount" beneath it.
    if (/^Sales$/i.test(label) || /^Amount$/i.test(label)) continue;

    /*
     * Six figures after the label, in the order the header names them. Positions are fixed by the
     * report and checked by the arithmetic below rather than assumed: a row whose parts do not add
     * up is reported, not quietly kept.
     */
    const [s1, d, r, sub, tax, total] = [1, 2, 3, 4, 5, 6].map((i) => salesCents(cells[i]));
    if (s1 === null && total === null) continue;

    /*
     * A totals line belongs to the section its own label names, not to the last heading seen.
     *
     * "Rx Sales Totals:" is printed after the two sub-headings that nest inside Rx Sales, so the
     * heading in hand when it arrives is "Rx Plan Third Party Remit" — and filing $664,038.50 of
     * all prescription sales under third-party remittance would lose the only line that has the
     * two halves added together. The label is the authority here; the heading is just where we are.
     */
    const closes = label.replace(/\s*(Sub)?totals?:$/i, "").trim();
    const isTotalsLine = /(Sub)?totals?:$/i.test(label);
    const kind: SalesRow["kind"] = !isTotalsLine ? "line" : closes === "" ? "total" : "subtotal";
    const belongsTo = isTotalsLine ? (closes === "" ? "" : SECTIONS.includes(closes) ? closes : section) : section;

    rows.push({
      section: belongsTo,
      label: closes || label,
      salesCents: s1,
      discountsCents: d,
      returnsCents: r,
      subtotalCents: sub,
      taxCents: tax,
      totalCents: total,
      kind,
    });

    /*
     * The report checking itself, line by line.
     *
     * Sales less discounts less returns is the subtotal — the columns are already signed, so it is
     * an addition. A row that fails this is a row whose columns are not where this reader thinks,
     * and every figure taken from it would be wrong the same way.
     */
    if (s1 !== null && d !== null && r !== null && sub !== null && Math.abs(s1 + d + r - sub) > 2) {
      problems.push(`"${label}" does not add up: ${s1 / 100} + ${d / 100} + ${r / 100} is not ${sub / 100}.`);
    }
  }

  const rowOf = (section: string, kind: SalesRow["kind"]) => rows.find((x) => x.section === section && x.kind === kind) ?? null;
  const find = (section: string, kind: SalesRow["kind"]) => rowOf(section, kind)?.totalCents ?? null;

  /*
   * Retail is the Subtotal column — sales less discounts less returns — not the Total, which adds
   * the sales tax on. On the real August the two differ by $380.87, and that is tax collected for
   * the state, not something the pharmacy sold. Prescriptions carry no tax, so their subtotal and
   * total agree and either column reads the same.
   */
  const retailRow = rowOf("Retail Sales", "subtotal") ?? rowOf("Retail Sales", "total");
  const retailCents = retailRow?.subtotalCents ?? retailRow?.totalCents ?? null;
  const retailTaxCents = retailRow?.taxCents ?? null;
  const retailWithTaxCents = retailRow?.totalCents ?? null;
  const rxPatientCents = find("Rx Plan Customer Payments", "subtotal");
  const rxRemitCents = find("Rx Plan Third Party Remit", "subtotal");
  const rxCents = find("Rx Sales", "subtotal");
  /*
   * The grand total is the one line closing no named section — the bare "Totals:". The "Other
   * Totals:" beneath it closes "Other", which is A/R movement rather than takings: real, worth
   * keeping, and not part of what the pharmacy sold.
   */
  const totalCents = rows.find((x) => x.kind === "total")?.totalCents ?? null;

  if (rows.length === 0) problems.push(`This does not look like the "${SALES_TITLE}" report — no figures were found in it.`);
  // The report's own Total column, section by section against its grand total: tax included on both sides.
  if (retailWithTaxCents !== null && rxCents !== null && totalCents !== null && Math.abs(retailWithTaxCents + rxCents - totalCents) > 2) {
    problems.push(
      `Retail and prescriptions do not add to the total the report printed: ${(retailWithTaxCents + rxCents) / 100} against ${totalCents / 100}.`,
    );
  }

  return {
    period,
    month: period && period.from.slice(0, 7) === period.to.slice(0, 7) ? period.from.slice(0, 7) : null,
    printedOn,
    rows,
    retailCents,
    retailTaxCents,
    rxPatientCents,
    rxRemitCents,
    rxCents,
    totalCents,
    problems,
  };
}
