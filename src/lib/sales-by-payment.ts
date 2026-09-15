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

  /* Rows placed by section. "Rx Sales Totals:" covers both prescription headings. */
  const inSection = (name: "retail" | "rx" | "adjust") =>
    parsed.filter((p) => (name === "retail" ? /^Retail Sales$/i.test(p.section) : name === "rx" ? /^Rx /i.test(p.section) : /^Sales Adjustments$/i.test(p.section)));
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
  checkTotals("Totals:", parsed);

  const grand = stated.get("Totals:");
  if (problems.length || !grand) {
    return { ok: false, why: `The payment-type report for ${periodFrom} to ${periodTo} does not hold together: ${problems.join("; ")}. Nothing was recorded.` };
  }
  const g = grand.payments.map(toCents);
  const payments: PaymentCents = { cash: g[0], check: g[1], card: g[2], account: g[3], coupons: g[4], returnsCash: g[5], returnsCard: g[6], returnsAccount: g[7], returnsCoupons: g[8] };
  const retail = stated.get("Retail Sales Totals:")!;
  const rxPatientCents = parsed.filter((p) => /customer payments/i.test(p.section)).reduce((n, p) => n + p.totalCents, 0);
  const rxRemitCents = parsed.filter((p) => /third party remit/i.test(p.section)).reduce((n, p) => n + p.totalCents, 0);
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
    },
  };
}

export function describeSalesByPayment(r: SalesByPayment): string {
  const span = r.periodFrom === r.periodTo ? r.periodFrom : `${r.periodFrom} to ${r.periodTo}`;
  const bits = [
    `cards ${money(r.cardNetCents)}${r.payments.returnsCard ? ` after ${money(-r.payments.returnsCard)} refunded to cards` : ""}`,
    `cash ${money(r.payments.cash + r.payments.returnsCash)}`,
    `cheques ${money(r.payments.check)}`,
  ];
  if (r.accountNetCents) bits.push(`charged to accounts ${money(r.accountNetCents)}`);
  if (r.payments.coupons + r.payments.returnsCoupons) bits.push(`coupons ${money(r.payments.coupons + r.payments.returnsCoupons)}`);
  return `Sales by payment type for ${span}: ${bits.join(", ")}. Prescriptions ${money(r.rxPatientCents)} from patients and ${money(r.rxRemitCents)} from plans; front of shop ${money(r.retailCents)} plus ${money(r.retailTaxCents)} sales tax.`;
}
