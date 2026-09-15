/**
 * The day an invoice says it will be paid, read off the invoice.
 *
 * Which invoices one ACH pays is a question the site had no answer to, and the answer turned out to be printed on the
 * invoices themselves. Parmed prints "PAYMENT TERMS : Semi mthly 15/EOM" and a DUE DATE on every one; all six of
 * September's say 10/10/2026, and its two portal payments did exactly that — 17–29 July taken on 25 August, 3–14 August
 * taken on 10 September. IPD's statement prints a due date per invoice as well.
 *
 * So this reads a printed date and never works one out. A supplier's terms are not turned into a date here: "net 15"
 * would be this site inventing a day the invoice does not name, and the whole point of the column is that a document
 * said it. Where nothing is printed the answer is null, which means "not said", not "due now".
 *
 * Pure.
 */

/** Two-digit years are this century: an invoice due in 1926 is a misread, not a due date. */
function isoFrom(month: number, day: number, year: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (y < 2020 || y > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // A day that does not exist in that month (31 September) is a misread of the columns, not a date.
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.getUTCDate() === day ? iso : null;
}

/**
 * The due date an invoice prints, or null where it prints none.
 *
 * The label is taken as it appears on the page — "DUE DATE", "Due Date:", "Date Due" — and the date read is the one that
 * comes next with nothing but spacing between. A PDF's text layer breaks a printed line into runs, so the label and its
 * value are often on separate lines of the extracted text even though they sit side by side on the page: on all six of
 * September's Parmed invoices they do. Requiring the same line read nothing at all.
 *
 * Nothing but spacing, though. Any other word or number between the label and the date means this is a column heading
 * with other columns after it, and the next date on the page belongs to something else — an invoice date, a statement
 * date, a ship date. The terms line ("Semi mthly 15/EOM Due 10/25 NM") names no year and is not a date either.
 */
export function dueDateFrom(text: string): string | null {
  const label = /\b(?:due\s*date|date\s*due)\b\s*:?\s*/gi;
  for (const m of text.matchAll(label)) {
    const after = text.slice(m.index + m[0].length);
    const us = /^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?!\d)/.exec(after);
    if (us) {
      const iso = isoFrom(Number(us[1]), Number(us[2]), Number(us[3]));
      if (iso) return iso;
    }
    const already = /^\s*(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(after);
    if (already) {
      const iso = isoFrom(Number(already[2]), Number(already[3]), Number(already[1]));
      if (iso) return iso;
    }
  }
  return null;
}
