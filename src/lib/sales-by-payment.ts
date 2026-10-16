import { parseCsvRows } from "./reference";

/**
 * PioneerRx's "System Sales Totals By Payment Type": what the till took, split by how it was paid.
 *
 * The owner, 15 September 2026, sending it daily: it answers the one question nothing else can — of a
 * day's takings, how much went on a card, how much was cash, a cheque, or charged to an account. Without
 * it the card batch could only be compared with the day's copays to within a range (91% over 3–14
 * September, 74% to 128% a day); with it the card column is the batch, to the cent.
 *
 * ── The shape, from the 30–31 August 2026 report ──
 *
 *   Nine payment columns — Cash, Check, Credit/Debit, A/R / Direct Dep, Coupons, and a Returns column for
 *   each — then Totals, Tax Collected, Tax Calculated. Data rows carry a label in the first cell, so a
 *   heading's column is one to the right of where the heading row prints it.
 *
 *   The payment columns include sales tax; Totals does not. OTC: 34.39 + 217.16 = 251.55 = 234.00 + 17.55.
 *   Returns are already negative. Payment figures carry four decimals and the totals rows two.
 *
 *   "Rx Plan Third Party Remit" rows have a Totals and no payment columns: that is the plans' money,
 *   adjudicated, never handed over at the till.
 *
 * ── What it is for ──
 *
 * Checks, not bookings. Accrual retail comes from the monthly System Sales Summary, cash from the card
 * batches and the bank. Booking cash from this as well would be the same money a third time.
 *
 * Pure.
 */

export const PAYMENT_TYPE_TITLE = "System Sales Totals By Payment Type";

const COLUMNS = ["Cash", "Check", "Credit/Debit", "A/R / Direct Dep", "Coupons", "Returns (Cash/Check)", "Returns (Credit/Debit)", "Returns (A/R / DD)", "Returns (Coupons)"] as const;

export type PaymentCents = { cash: number; check: number; card: number; account: number; coupons: number; returnsCash: number; returnsCard: number; returnsAccount: number; returnsCoupons: number };

export type PaymentRow = { section: string; label: string; payments: PaymentCents | null; totalCents: number; taxCents: number };

export type SalesByPayment = {
  periodFrom: string;
  periodTo: string;
  printedOn: string | null;
  payments: PaymentCents;
  /** Card payments less card refunds: the figure the card batch should come to. */
  cardNetCents: number;
  /** Charged to a patient's account rather than paid. Money still owed. */
  accountNetCents: number;
  retailCents: number;
  retailTaxCents: number;
  rxPatientCents: number;
  rxRemitCents: number;
  adjustmentsCents: number;
  totalCents: number;
  rows: PaymentRow[];
  /**
   * The till was read and it took nothing.
   *
   * Which is what a Sunday looks like: PioneerRx leaves a section off the page entirely when it has
   * no rows, so a closed day prints no "Retail Sales" and no "Rx Sales" at all — and the reader,
   * which required both, called it a report that does not hold together. Two Sundays in September
   * were refused that way while the report was perfectly correct.
   *
   * It says nothing was sold and deliberately not that the shop was shut, because it cannot tell
   * the difference: a day open to no customers prints its sections with noughts in them, and would
   * be described as closed by anything that read absence of sections as absence of trade. What is
   * true of both is the part worth reporting — and it is measured-and-none rather than missing,
   * which is the distinction that matters to anybody looking for a day that failed to arrive.
   */
  nothingSold: boolean;
};

export type SalesByPaymentRead = { ok: true; report: SalesByPayment } | { ok: false; why: string };

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (mdy: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/** Four-decimal figures kept whole to a hundredth of a cent, so a row can be summed before it is rounded. */
const tenThousandths = (s: string | undefined): number | null => {
  const t = (s ?? "").trim().replace(/[$,]/g, "");
  if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Math.round(Number(t) * 10000);
};
const toCents = (x: number) => Math.round(x / 100);

export function looksLikeSalesByPayment(text: string): boolean {
  return text.replace(/^﻿/, "").slice(0, 2000).includes(PAYMENT_TYPE_TITLE);
}

export function readSalesByPayment(text: string): SalesByPaymentRead {
  if (!looksLikeSalesByPayment(text)) return { ok: false, why: "Not a System Sales Totals By Payment Type report." };
  const rows = parseCsvRows(text.replace(/^﻿/, "").replace(/\r\n/g, "\n")).map((r) => r.map((c) => c.trim()));

  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  let printedOn: string | null = null;
  let headerAt = -1;
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i][0] ?? "";
    const p = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/.exec(first);
    if (p && !periodFrom) {
      periodFrom = iso(p[1]);
      periodTo = iso(p[2]);
    }
    const printed = /^Printed On:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(first);
    if (printed) printedOn = iso(printed[1]);
    if (headerAt < 0 && first === "Cash" && rows[i].includes("Totals")) headerAt = i;
  }
  if (!periodFrom || !periodTo) return { ok: false, why: "The report's date range could not be read." };
  if (headerAt < 0) return { ok: false, why: "The payment-type heading row could not be found." };

  /* Where each column sits in a data row: one to the right of the heading, because the label comes first. */
  const heads = rows[headerAt];
  const at: number[] = [];
  for (const name of COLUMNS) {
    const i = heads.indexOf(name);
    if (i < 0) return { ok: false, why: `The "${name}" column is missing — PioneerRx has changed the report, and nothing was read.` };
    at.push(i + 1);
  }
  const totalAt = heads.indexOf("Totals");
  if (totalAt < 0) return { ok: false, why: `The "Totals" column is missing, and nothing was read.` };
  const sub = rows[headerAt + 1] ?? [];
  const taxAt = sub.indexOf("Tax Collected");
  if (taxAt < 0) return { ok: false, why: `The "Tax Collected" column is missing, and nothing was read.` };
  const totalCol = totalAt + 1;
  const taxCol = taxAt + 1;

  const problems: string[] = [];
  const parsed: PaymentRow[] = [];
  const stated = new Map<string, { payments: number[]; total: number; tax: number }>();
  let section = "";
  for (let i = headerAt + 2; i < rows.length; i++) {
    const r = rows[i];
    const label = r[0] ?? "";
    if (!label || /^Printed On:/i.test(label)) continue;
    const nonEmpty = r.slice(1).filter((c) => c !== "").length;
    if (nonEmpty === 0) {
      /* A heading. "Rx Plan Customer Payments" and "…Third Party Remit" sit inside "Rx Sales". */
      section = label;
      continue;
    }
    const pays = at.map((c) => tenThousandths(r[c]));
    const total = tenThousandths(r[totalCol]);
    const tax = tenThousandths(r[taxCol]);
    if (total === null || tax === null) {
      problems.push(`"${label}" has no readable total or tax`);
      continue;
    }
    if (/Totals:$/.test(label)) {
      if (pays.some((p) => p === null)) problems.push(`"${label}" has an unreadable payment figure`);
      stated.set(label, { payments: pays.map((p) => p ?? 0), total, tax });
      continue;
    }
    const hasPayments = pays.some((p) => p !== null);
    if (hasPayments && pays.some((p) => p === null)) {
      problems.push(`"${label}" has an unreadable payment figure`);
      continue;
    }
    const cents = pays.map((p) => toCents(p ?? 0));
    parsed.push({
      section,
      label,
      payments: hasPayments
        ? { cash: cents[0], check: cents[1], card: cents[2], account: cents[3], coupons: cents[4], returnsCash: cents[5], returnsCard: cents[6], returnsAccount: cents[7], returnsCoupons: cents[8] }
        : null,
      totalCents: toCents(total),
      taxCents: toCents(tax),
    });
    /* Every row with payments: what was handed over is the sale plus its tax. Summed before rounding; a cent allowed for the four decimals. */
    if (hasPayments) {
      const handed = pays.reduce<number>((n, p) => n + (p ?? 0), 0);
      if (Math.abs(toCents(handed) - toCents(total + tax)) > 1) {
        problems.push(`"${label}" payments come to ${money(toCents(handed))} against a total with tax of ${money(toCents(total + tax))}`);
      }
    }
  }

  /*
   * A day the shop was shut.
   *
   * PioneerRx prints no section at all where a section has no rows, so a closed Sunday carries the
   * adjustments block, a "Totals:" line of nought, and nothing else — no "Retail Sales", no "Rx
   * Sales". Requiring those rows refused 20 and 27 September 2026 as reports that "do not hold
   * together" when both were correct and the pharmacy was simply closed.
   *
   * Only a genuinely nil day is let through, and the page has to prove it: the "Totals:" row must
   * exist and be nought in every column including tax, and no row anywhere on the page may carry
   * money. A file truncated after a section of real sales fails both, because the printed grand
   * total still holds the sales that were cut off — so this cannot turn a damaged report into a
   * quiet zero.
   */
  const grandStated = stated.get("Totals:");
  const nothingSold =
    !!grandStated &&
    grandStated.total === 0 &&
    grandStated.tax === 0 &&
    grandStated.payments.every((p) => p === 0) &&
    parsed.every((p) => p.totalCents === 0 && p.taxCents === 0 && (p.payments === null || Object.values(p.payments).every((v) => v === 0)));
  if (nothingSold) {
    for (const label of ["Retail Sales Totals:", "Rx Sales Totals:", "Sales Adjustments Totals:"]) {
      if (!stated.has(label)) stated.set(label, { payments: COLUMNS.map(() => 0), total: 0, tax: 0 });
    }
  }

  /*
   * Rows placed by section.
   *
   * "Rx Sales Totals:" covers every prescription heading, and there are more of them than the two
   * this once knew about. `/^Rx /` matched "Rx Sales", "Rx Plan Customer Payments" and "Rx Plan
   * Third Party Remit" and quietly missed "Non-Adjudicated Rx Sales" — a cash-price prescription,
   * sold without billing a plan. On 25 September 2026 that was one row of $180.00, and dropping it
   * put the Rx total, the Rx card column, the grand total and the grand card column all exactly
   * $180.00 out. The report was right; the reader had never been shown a heading of that shape.
   *
   * So the test is the word Rx anywhere in the heading, and anything this cannot place is named
   * below rather than silently left out of a total it belongs in — which is how $180.00 became four
   * arithmetic complaints about PioneerRx instead of one sentence about this file.
   */
  const RETAIL = /^Retail Sales$/i;
  const RX = /\bRx\b/i;
  const ADJUST = /^Sales Adjustments$/i;
  /* Printed below the "Totals:" line and deliberately outside it. See the note on "Totals:" below. */
  const OUTSIDE = /^Other$/i;
  const inSection = (name: "retail" | "rx" | "adjust") =>
    parsed.filter((p) => (name === "retail" ? RETAIL.test(p.section) : name === "rx" ? RX.test(p.section) : ADJUST.test(p.section)));

  for (const heading of new Set(parsed.map((p) => p.section))) {
    if (RETAIL.test(heading) || RX.test(heading) || ADJUST.test(heading) || OUTSIDE.test(heading)) continue;
    problems.push(`rows sit under "${heading}", a heading this reader does not place in Retail, Rx or Adjustments, so their money is in no total`);
  }

  const checkTotals = (label: string, part: PaymentRow[]) => {
    const s = stated.get(label);
    if (!s) {
      problems.push(`the "${label}" row is missing`);
      return;
    }
    const sum = (f: (p: PaymentRow) => number) => part.reduce((n, p) => n + f(p), 0);
    const keys: (keyof PaymentCents)[] = ["cash", "check", "card", "account", "coupons", "returnsCash", "returnsCard", "returnsAccount", "returnsCoupons"];
    keys.forEach((k, idx) => {
      const got = sum((p) => p.payments?.[k] ?? 0);
      if (Math.abs(got - toCents(s.payments[idx])) > 1) problems.push(`"${label}" ${COLUMNS[idx]} is ${money(toCents(s.payments[idx]))} but its rows come to ${money(got)}`);
    });
    if (Math.abs(sum((p) => p.totalCents) - toCents(s.total)) > 1) problems.push(`"${label}" Totals is ${money(toCents(s.total))} but its rows come to ${money(sum((p) => p.totalCents))}`);
  };
  checkTotals("Retail Sales Totals:", inSection("retail"));
  checkTotals("Rx Sales Totals:", inSection("rx"));
  checkTotals("Sales Adjustments Totals:", inSection("adjust"));
  /*
   * The grand total is the three sales sections, and deliberately not everything on the page.
   *
   * "Other" is printed BELOW the Totals: line and is not inside it. On 17 September 2026 it carried
   * one row — Customer A/R Payments, −$30.00 — and summing every parsed row made the reader report
   * the report's own total as thirty dollars too high, on both the card column and the grand total.
   * It refused the whole day rather than store a till that disagreed with itself, and that day's
   * takings went unrecorded because of a section PioneerRx had correctly excluded.
   *
   * Proved on the page itself: 218.41 + 3,273.30 + 0.00 is exactly the printed 3,491.71, and
   * 203.18 + 33,718.27 + 0.00 is exactly the printed 33,921.45. The report adds up; the reader was
   * adding a section the report does not.
   *
   * And it belongs outside: a Customer A/R payment is money collected against an account that was
   * billed earlier, not a sale made today. Counting it as takings would put revenue in the day twice
   * — once when the sale was rung up and again when the customer settled.
   */
  checkTotals("Totals:", [...inSection("retail"), ...inSection("rx"), ...inSection("adjust")]);

  /*
   * The prescription split adds back up to the prescription total.
   *
   * The checks above prove every Rx row is inside the section's printed total; this proves the two
   * numbers the rest of the site actually reads still carry all of it between them. It is the one
   * fault the arithmetic above cannot see, because a row can be counted in the section and dropped
   * from the split, which is exactly what happened to $180.00 of cash-price prescriptions.
   */
  const rxStated = stated.get("Rx Sales Totals:");
  if (rxStated) {
    const split = inSection("rx").reduce((n, p) => n + p.totalCents, 0);
    if (Math.abs(split - toCents(rxStated.total)) > 1) {
      problems.push(`the prescription rows come to ${money(split)} but "Rx Sales Totals:" says ${money(toCents(rxStated.total))}`);
    }
  }

  const grand = stated.get("Totals:");
  if (problems.length || !grand) {
    return { ok: false, why: `The payment-type report for ${periodFrom} to ${periodTo} does not hold together: ${problems.join("; ")}. Nothing was recorded.` };
  }
  const g = grand.payments.map(toCents);
  const payments: PaymentCents = { cash: g[0], check: g[1], card: g[2], account: g[3], coupons: g[4], returnsCash: g[5], returnsCard: g[6], returnsAccount: g[7], returnsCoupons: g[8] };
  const retail = stated.get("Retail Sales Totals:")!;
  /*
   * The two halves of prescription money, split so that nothing can fall between them.
   *
   * These were "customer payments" and "third party remit", named heading by heading, and a third
   * Rx heading therefore reached neither. "Non-Adjudicated Rx Sales" — a cash-price prescription —
   * is money a patient handed over, and on 25 September 2026 its $180.00 was in the Rx total, in
   * the grand total, and in neither of these. Every figure balanced and the split under-reported
   * what patients paid.
   *
   * So only the plans' half is named: a "Third Party Remit" row is adjudicated money that never
   * reached the till, which is the one thing a heading has to say. Everything else in the Rx
   * section is what somebody paid, and a heading nobody has thought of yet lands on the patients'
   * side rather than nowhere. They are checked against the section's own printed total below.
   */
  const rxRows = inSection("rx");
  const rxRemitCents = rxRows.filter((p) => /third party remit/i.test(p.section)).reduce((n, p) => n + p.totalCents, 0);
  const rxPatientCents = rxRows.reduce((n, p) => n + p.totalCents, 0) - rxRemitCents;
  const adjustmentsCents = toCents(stated.get("Sales Adjustments Totals:")!.total);

  return {
    ok: true,
    report: {
      periodFrom,
      periodTo,
      printedOn,
      payments,
      cardNetCents: payments.card + payments.returnsCard,
      accountNetCents: payments.account + payments.returnsAccount,
      retailCents: toCents(retail.total),
      retailTaxCents: toCents(grand.tax),
      rxPatientCents,
      rxRemitCents,
      adjustmentsCents,
      totalCents: toCents(grand.total),
      rows: parsed,
      nothingSold,
    },
  };
}

export function describeSalesByPayment(r: SalesByPayment): string {
  const span = r.periodFrom === r.periodTo ? r.periodFrom : `${r.periodFrom} to ${r.periodTo}`;
  /*
   * A nil day says it took nothing, and says it was measured.
   *
   * Listing nine payment types at nought each reads as a report that failed, which is what this was
   * refused as for two Sundays. One sentence, and it is clear the till was read rather than the day
   * being still to arrive.
   *
   * It does not say the shop was shut. The first version of this sentence said the page "carries no
   * sales sections at all", which is true of a Sunday and false of a day that opened and took
   * nothing — and this cannot tell those apart. A sentence that states the one thing checked is
   * worth more than one that states the likely reason.
   */
  if (r.nothingSold) {
    return `Sales by payment type for ${span}: nothing was sold — every figure on the report is nought, which on a Sunday or a holiday is what a closed day looks like. The till was read, not missed.`;
  }
  const bits = [
    `cards ${money(r.cardNetCents)}${r.payments.returnsCard ? ` after ${money(-r.payments.returnsCard)} refunded to cards` : ""}`,
    `cash ${money(r.payments.cash + r.payments.returnsCash)}`,
    `cheques ${money(r.payments.check)}`,
  ];
  if (r.accountNetCents) bits.push(`charged to accounts ${money(r.accountNetCents)}`);
  if (r.payments.coupons + r.payments.returnsCoupons) bits.push(`coupons ${money(r.payments.coupons + r.payments.returnsCoupons)}`);
  return `Sales by payment type for ${span}: ${bits.join(", ")}. Prescriptions ${money(r.rxPatientCents)} from patients and ${money(r.rxRemitCents)} from plans; front of shop ${money(r.retailCents)} plus ${money(r.retailTaxCents)} sales tax.`;
}
