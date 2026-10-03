/**
 * Parmed's EFT debit notice: the invoices one ACH is about to take out of the bank.
 *
 * Parmed pays itself. It sends this notice the day before the debit — "You should see a corresponding entry in your
 * bank account upon processing the next business day" — listing every invoice inside the one ACH. That is the only
 * document that says what the debit is for, and without it the debit is a bank line matching no single invoice, which
 * is exactly the case `placeLine`'s amount rules cannot settle (`docs/HANDOFF.md`, 15 September).
 *
 * The first one to arrive, on 26 September 2026, was filed as "a PDF this does not recognise" and named twelve invoices
 * for $2,825.92 — none of which is on file, because every one of them is dated in August and the invoice feed here
 * begins on 9 September. So the payment is written naming what it says it pays, and the invoices it names are an
 * explicit state rather than a silence: `notCaptured` below.
 *
 * ── Why the total is proved rather than read ──
 *
 * The page prints its own total. A reader that trusts a printed total believes the one thing on the page it cannot
 * check, and this figure is a bank debit. So the twelve line amounts are added and compared, and a page whose lines do
 * not reach its own total yields nothing at all: `readParmedEftNotice` returns null and the document stays where a
 * person will look at it. The same rule as `bill-total.ts`, for the same reason.
 *
 * ── Shape ──
 *
 *   Notice Date  Customer No
 *   <MM/DD/YYYY>  <customer no>
 *   Details of the Invoices to be paid
 *   DATESHIP TO PARTYINVOICE NUMBERPURCHASE ORDERAMOUNT
 *      <ship-to party>                       <- often, not always: two of the twelve have none
 *   <MM/DD/YYYY><customer no><invoice no>        <amount>
 *   Total (in USD)$        <total>
 *
 * The customer number runs into the date on its left and the invoice number on its right with no separator, so it is
 * read from the header first and then used to split the row. A row that does not carry it is not a row of this notice.
 *
 * Pure. `parmed-eft-notice-store.ts` writes.
 */

export type ParmedEftInvoice = {
  /** Parmed's own invoice number, as printed. */
  invoiceNumber: string;
  /** ISO. The day the invoice was raised, not the day it is paid. */
  invoiceDate: string;
  cents: number;
};

export type ParmedEftNotice = {
  /** ISO. The day the notice is dated, which is the day the debit is submitted. */
  noticeOn: string;
  /** Parmed's customer number for this pharmacy. Its identity: one notice per number per day. */
  customerNumber: string;
  invoices: ParmedEftInvoice[];
  /** What the invoices come to, having been added here and agreed with the printed total. */
  totalCents: number;
};

const iso = (mdy: string): string => {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m}-${d}`;
};

const cents = (s: string): number => Math.round(Number(s.replace(/,/g, "")) * 100);

/**
 * Is this Parmed's debit notice?
 *
 * Both halves are required. The heading alone would catch a covering email quoting it; the subject line alone would
 * catch a different Parmed document about the same ACH.
 */
export function looksLikeParmedEftNotice(text: string): boolean {
  return /EFT\s+DEBIT\s+NOTICE/i.test(text) && /ACH\s+DEBIT\s+VERIFICATION/i.test(text) && /PARMED/i.test(text);
}

/**
 * The notice, or null where the page does not hold together.
 *
 * Null on every one of: no customer number, no notice date, no invoice rows, no printed total, and — the one that
 * matters — a printed total the rows do not reach.
 */
export function readParmedEftNotice(text: string): ParmedEftNotice | null {
  if (!looksLikeParmedEftNotice(text)) return null;
  const lines = text.split(/\r?\n/);

  /* The header pairs a date and the customer number on one line, under "Notice Date  Customer No". */
  let noticeOn = "";
  let customerNumber = "";
  for (const line of lines) {
    const m = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{6,})\s*$/.exec(line);
    if (m) {
      noticeOn = iso(m[1]);
      customerNumber = m[2];
      break;
    }
  }
  if (!noticeOn || !customerNumber) return null;

  /*
   * The row, and why the customer number is checked rather than built into the pattern.
   *
   * Date, then one unbroken run of digits, then the amount. The run is the customer number and the invoice number with
   * nothing between them, so it is split here by length: a run that does not begin with this page's own customer number
   * is not a row of this notice, and is passed over rather than guessed at.
   */
  const row = /^\s*(\d{2}\/\d{2}\/\d{4})(\d{8,})\s+([\d,]+\.\d{2})\s*$/;
  const invoices: ParmedEftInvoice[] = [];
  for (const line of lines) {
    const m = row.exec(line);
    if (!m) continue;
    if (!m[2].startsWith(customerNumber)) continue;
    const invoiceNumber = m[2].slice(customerNumber.length);
    if (invoiceNumber.length < 4) continue;
    invoices.push({ invoiceDate: iso(m[1]), invoiceNumber, cents: cents(m[3]) });
  }
  if (invoices.length === 0) return null;

  const printed = /Total\s*\(in USD\)\s*\$\s*([\d,]+\.\d{2})/i.exec(text);
  if (!printed) return null;

  const added = invoices.reduce((n, v) => n + v.cents, 0);
  if (added !== cents(printed[1])) return null;

  return { noticeOn, customerNumber, invoices, totalCents: added };
}
