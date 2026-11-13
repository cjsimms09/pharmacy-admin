/**
 * PioneerRx's "Loan Search Results": stock that left the building to somebody who is not a patient.
 *
 * It arrived on 30 September 2026 as a scheduled delivery and was filed as "a PDF this does not
 * recognise", which is how a whole stream of money stayed invisible. Every row on the owner's own
 * report is `Loan Type: Sale`, `Loan Status: Active`, status **Pending** — thirty-odd lines across
 * September, most of them to West Wichita Family Physicians and West Wichita Surgery Center, in
 * amounts from $7.44 to $1,556.78. Botox, testosterone, methylprednisolone, bags of saline.
 *
 * ── What this reader does and deliberately does not do ──
 *
 * It reads. It books nothing, and that is not caution for its own sake: the report prints **no
 * total**. Every other reader here is checked by arithmetic against a figure the document states —
 * `bill-total.ts` refuses a page whose parts do not reach its printed total, the payment-type reader
 * refuses a day whose rows do not reach its own subtotals. This page gives nothing to check against,
 * so the sum below is this reader's own arithmetic over the rows it managed to match, and it says so
 * rather than presenting it as the report's figure.
 *
 * And whether this money is already counted is a question the data cannot answer. A sale to the
 * clinic may be ringing through the till and sitting in the System Sales Summary already, in which
 * case booking it here would be the $28,645.57 fault again — the same money twice, in the flattering
 * direction. It needs the owner, and until he says, this reads the page and books nothing.
 *
 * ── The shape ──
 *
 *   Loan Search Results
 *   West Wichita Family Pharmacy
 *   Loan Type: Sale
 *   Loan Status: Active
 *   Prescriber or External LocationItemNDCQuantityPriceLoaned OnReturned OnStatusType
 *   <location><item><NDC><quantity>$<price><loaned><returned?><status><type>
 *
 * Every column runs into the next with no separator, as everywhere else in this system's PDFs. The
 * NDC is the anchor — five-four-two with its hyphens, which nothing else on the line looks like — so
 * the row is read outwards from it rather than left to right. What sits in front of it is the
 * location and the drug's name run together; where the location is an external one PioneerRx marks
 * it `(*1)`, `(*3)` and so on, and that marker is the only honest place to cut. Where there is no
 * marker the two cannot be told apart, and the whole prefix is kept as written rather than guessed
 * at — `DESTROYS` and the pharmacy's own name both turn up there.
 *
 * Pure.
 */

export type LoanRow = {
  /** Location and item as printed, split on PioneerRx's own `(*n)` marker where it gives one. */
  location: string | null;
  item: string;
  /** Eleven digits, hyphens removed, as every other code in this system is held. */
  ndc11: string;
  quantity: number;
  cents: number;
  /** ISO. The day the stock left. */
  loanedOn: string;
  /** ISO, where the report shows one. Null is a real state: it has not come back. */
  returnedOn: string | null;
  status: string;
  type: string;
};

export type LoanReport = {
  loanType: string | null;
  loanStatus: string | null;
  printedOn: string | null;
  rows: LoanRow[];
  /**
   * What the rows come to, added here.
   *
   * Not the report's figure — it prints none. Named this way so nothing downstream can mistake it
   * for one the document stated and checked.
   */
  addedUpCents: number;
  /** Lines that looked like rows and could not be read, so a silent drop is impossible. */
  unreadable: string[];
};

const iso = (mdy: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

const cents = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

export function looksLikeLoanReport(text: string): boolean {
  return /Loan\s+Search\s+Results/i.test(text) && /Prescriber or External Location/i.test(text);
}

/*
 * The row, read outwards from the NDC.
 *
 * Quantity and price are both two-decimal and adjacent, so the dollar sign between them is what
 * separates them and is required. Both dates are optional in the sense that the second one often is
 * not printed; the first always is, and a row without it is not a row of this report.
 */
const ROW = /^(.+?)(\d{5}-\d{4}-\d{2})([\d,]+\.\d{2})\$([\d,]+\.\d{2})(\d{1,2}\/\d{1,2}\/\d{4})(\d{1,2}\/\d{1,2}\/\d{4})?([A-Za-z]+?)(Sale|Loan|Borrow|Transfer)\s*$/;

export function readLoanReport(text: string): LoanReport | null {
  if (!looksLikeLoanReport(text)) return null;
  const lines = text.split(/\r?\n/);

  const loanType = /Loan\s+Type:\s*(.+?)\s*$/im.exec(text)?.[1] ?? null;
  const loanStatus = /Loan\s+Status:\s*(.+?)\s*$/im.exec(text)?.[1] ?? null;
  const printedOn = iso(/Printed\s+On:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text)?.[1] ?? "");

  const rows: LoanRow[] = [];
  const unreadable: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^Loan|^West Wichita Family Pharmacy$|^Prescriber or External|^Printed On:/i.test(t)) continue;
    const m = ROW.exec(t);
    if (!m) {
      /* Only a line that carries an NDC is a row that failed; the rest is headings and furniture. */
      if (/\d{5}-\d{4}-\d{2}/.test(t)) unreadable.push(t.slice(0, 200));
      continue;
    }
    const loanedOn = iso(m[5]);
    if (!loanedOn) {
      unreadable.push(t.slice(0, 200));
      continue;
    }
    /* PioneerRx's own marker for an external location is the only honest place to cut the prefix. */
    const prefix = m[1];
    const cut = /^(.*?\(\*\d+\))(.+)$/.exec(prefix);
    rows.push({
      location: cut ? cut[1] : null,
      item: (cut ? cut[2] : prefix).trim(),
      ndc11: m[2].replace(/-/g, ""),
      quantity: Number(m[3].replace(/,/g, "")),
      cents: cents(m[4]),
      loanedOn,
      returnedOn: m[6] ? iso(m[6]) : null,
      status: m[7],
      type: m[8],
    });
  }

  if (rows.length === 0) return null;
  return { loanType, loanStatus, printedOn, rows, addedUpCents: rows.reduce((n, r) => n + r.cents, 0), unreadable };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the report holds, for the inbox line. Books nothing and says so. */
export function describeLoanReport(r: LoanReport): string {
  const outstanding = r.rows.filter((x) => !x.returnedOn);
  const whoTo = [...new Set(outstanding.map((x) => x.location).filter((x): x is string => Boolean(x)))];
  const span = r.rows.map((x) => x.loanedOn).sort();
  return (
    `${r.rows.length} ${r.loanType ? `${r.loanType.toLowerCase()} ` : ""}loan${r.rows.length === 1 ? "" : "s"} ` +
    `from ${span[0]} to ${span[span.length - 1]}, ${money(r.addedUpCents)} between them` +
    `${whoTo.length ? `, ${outstanding.length} not yet returned to ${whoTo.length === 1 ? whoTo[0] : `${whoTo.length} locations`}` : ""}. ` +
    `Added up here: the report prints no total of its own, so nothing on this page checks the arithmetic. ` +
    `Nothing is booked from it — whether these sales are already in the till's own figures is a question for the owner, and ` +
    `counting them twice would flatter the month.` +
    `${r.unreadable.length ? ` ${r.unreadable.length} line${r.unreadable.length === 1 ? "" : "s"} carried an NDC and could not be read.` : ""}`
  );
}
