import { parseCsvRows } from "./reference";

/**
 * Reading the payer payment report: what the plans actually put in the bank.
 *
 * This is the money side of a claim, and until now the site had no way to see it. A claim says
 * what a plan *agreed* to pay; only this says what arrived, on what day, in one deposit. On the
 * cash account those are different figures on different dates, and the cash account had been
 * running on receipts typed in by hand off a bank statement.
 *
 * One row is one payment: a payer, a payment number, the date it was deposited, and the amount.
 * That is all the cash account needs and it is all this reads as money. The match columns are
 * recorded and deliberately not used — remittance and claim matching belong to the 835 work that
 * has not been set up yet, and a figure used before its source is understood is how a set of
 * books goes quietly wrong.
 *
 * ── Why the payment number matters more than it looks ──
 *
 * The report is a date range, and a date range gets re-run: the same week arrives twice with a day
 * added, or somebody forwards last month's again. Every row carries the payer's own payment
 * number, which is unique to the payment, so a payment already banked is recognised and skipped
 * rather than counted twice. Without that this file would inflate revenue every time it landed.
 */

export type PayerPayment = {
  /** The payer's own number for the payment: the identity that stops it being banked twice. */
  paymentNumber: string;
  payerName: string;
  /** The day it reached the bank. This, not the payment date, is when the money is the pharmacy's. */
  depositedOn: string;
  /** The day the payer says it paid, which can be earlier. Kept because a gap is worth seeing. */
  paidOn: string | null;
  amountCents: number;
  /** "EFT", "COPY", "CHECK" — as the report writes it. */
  method: string | null;
  /*
   * Recorded, and not used for anything yet.
   *
   * These are the report's own reconciliation columns: whether a remittance advice was matched to
   * the payment, what of it matched claims, and what did not. They are the beginning of the 835
   * work rather than part of it, so they are stored as they arrive and no figure on this site is
   * drawn from them until that work is done and understood.
   */
  remitMatched: boolean | null;
  claimMatchCents: number | null;
  noClaimMatchCents: number | null;
  adjustmentsCents: number | null;
};

export type PayerPaymentRead = {
  payments: PayerPayment[];
  /** Rows the reader would not take, and why, so a changed export is visible rather than silent. */
  skipped: { row: number; why: string }[];
  from: string | null;
  to: string | null;
  totalCents: number;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The columns this report is known by. All four must be there; a file missing one is not this. */
const REQUIRED = ["paymentnumber", "payername", "depositdate", "paymentamt"];

/**
 * Whether a file is a payer payment report, from its header row rather than its name.
 *
 * The name carries the pharmacy and a date range and nothing about the shape, so it is no use for
 * this. Positive evidence only: a file that merely lacks another report's markers is never assumed
 * to be this one.
 */
export function looksLikePayerPayments(text: string): boolean {
  const head = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  if (!head) return false;
  const cols = new Set(head.split(",").map((c) => norm(c.replace(/^"|"$/g, ""))));
  return REQUIRED.every((r) => cols.has(r));
}

/** "09/01/2026" → "2026-09-01". Anything else is null rather than a guess. */
function iso(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/**
 * Dollars to cents without going through binary fractions.
 *
 * `Math.round(8829.73 * 100)` is right and `63298.82 * 100` is 6329881.9999… — the same expression
 * that has been quietly losing a cent at a time in accounting software since floating point was
 * invented. Read as text, the digits are exact.
 */
export function moneyCents(s: string | undefined): number | null {
  const t = (s ?? "").trim().replace(/[$,]/g, "");
  if (!t) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

const yesNo = (s: string | undefined): boolean | null => {
  const t = (s ?? "").trim().toLowerCase();
  if (t === "1" || t === "y" || t === "yes" || t === "true") return true;
  if (t === "0" || t === "n" || t === "no" || t === "false") return false;
  return null;
};

/** Reads the report. Pure: text in, payments out, and every rejected row says why. */
export function parsePayerPayments(text: string): PayerPaymentRead {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""));
  const payments: PayerPayment[] = [];
  const skipped: { row: number; why: string }[] = [];
  const seen = new Set<string>();
  if (rows.length === 0) return { payments, skipped, from: null, to: null, totalCents: 0 };

  // The header names the columns; their order is the export's business and has changed before.
  const at = new Map<string, number>();
  rows[0].forEach((h, i) => at.set(norm(h), i));

  rows.slice(1).forEach((raw, i) => {
    const get = (want: string): string | undefined => {
      const j = at.get(want);
      return j === undefined ? undefined : raw[j];
    };
    const paymentNumber = (get("paymentnumber") ?? "").trim();
    const payerName = (get("payername") ?? "").trim();
    const depositedOn = iso(get("depositdate"));
    const amountCents = moneyCents(get("paymentamt"));

    if (!paymentNumber) return void skipped.push({ row: i + 2, why: "no payment number, so it could not be told apart from another payment" });
    if (!payerName) return void skipped.push({ row: i + 2, why: "no payer" });
    if (!depositedOn) return void skipped.push({ row: i + 2, why: `no readable deposit date (“${get("depositdate") ?? ""}”)` });
    if (amountCents === null) return void skipped.push({ row: i + 2, why: `no readable amount (“${get("paymentamt") ?? ""}”)` });
    // A payment of nothing is a line the report prints, not money that arrived.
    if (amountCents === 0) return void skipped.push({ row: i + 2, why: "the payment is zero" });

    /*
     * A payment number is unique to a payer, not across payers, so the pair is the identity.
     * Within one file a repeat is the report printing a payment twice, which is not two payments.
     */
    const key = `${payerName.toLowerCase()}|${paymentNumber}`;
    if (seen.has(key)) return void skipped.push({ row: i + 2, why: `payment ${paymentNumber} from ${payerName} is listed twice in this file` });
    seen.add(key);

    payments.push({
      paymentNumber,
      payerName,
      depositedOn,
      paidOn: iso(get("paymentdate")),
      amountCents,
      method: (get("paymenttype") ?? "").trim() || null,
      remitMatched: yesNo(get("remitmatch")),
      claimMatchCents: moneyCents(get("claimmatch")),
      noClaimMatchCents: moneyCents(get("noclaimmatch")),
      adjustmentsCents: moneyCents(get("adjustments")),
    });
  });

  const dates = payments.map((p) => p.depositedOn).sort();
  return {
    payments,
    skipped,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    totalCents: payments.reduce((n, p) => n + p.amountCents, 0),
  };
}

/**
 * The date range a payment report's file name states, where it states one.
 *
 * "West_Wichita_Family_Pharmacy_1722734_20260901_20260907.csv" is the first through the seventh of
 * September. Worth having because a report can legitimately come back empty — a week with no
 * deposits is a fact — and without the name there would be nothing to say what was checked.
 */
export function rangeFromFileName(fileName: string): { from: string; to: string } | null {
  const m = /(\d{4})(\d{2})(\d{2})[_-](\d{4})(\d{2})(\d{2})(?:\.[a-z]+)?$/i.exec(fileName.trim());
  if (!m) return null;
  return { from: `${m[1]}-${m[2]}-${m[3]}`, to: `${m[4]}-${m[5]}-${m[6]}` };
}
