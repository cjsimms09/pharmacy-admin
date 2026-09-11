/**
 * A wholesaler's statement of account: which invoices are about to be taken, and when.
 *
 * The owner: "we need to be able to match payments from bank to invoices once we have bank
 * statement", and then "will be getting on fridays at noon... make sure system uses it correctly
 * for cash accounting (no duplicates) and is able to match payments to bank statement".
 *
 * ── What a statement is, and what it is not ──
 *
 * It is NOT a bill and must never become one. Every line on it is an invoice this site already
 * holds, or will hold; booking the statement as a cost would count the whole month's buying twice.
 * That is the single largest double-count this system could make — $126,538.20 on the first one.
 *
 * What it adds is three things nothing else has:
 *
 *   the due date  — McKesson takes the money by ACH on it. Every invoice sharing a due date is
 *                   taken as ONE debit, which is why a bank line never matches an invoice and why
 *                   matching by amount has been impossible. The statement is the missing key.
 *   the net       — what is actually debited, after the prompt-pay discount. The invoice prints
 *                   $8,760.69; the bank will show $8,585.48. Cash accounting wants the second.
 *   the discount  — 2.00% on the first statement read, $2,530.77 across 38 invoices. Real money
 *                   the books had no way of knowing about.
 *
 * ── The arithmetic check ──
 *
 * Gross less discount is net, on every line, or the line is not read. The columns run together on
 * this layout exactly as they do on the invoices, and a misread column would put a plausible wrong
 * figure against an invoice number. The line's own arithmetic is the only defence, as everywhere
 * else here.
 *
 * Pure — it takes text and returns figures, so it is tested against the real statement rather than
 * against whatever is in the database today.
 */

export type StatementLine = {
  /** The wholesaler's own invoice number. What ties this to an invoice already on file. */
  invoiceNumber: string;
  /** The day the invoice was billed. */
  billedOn: string;
  /** The day the money is taken. Every line sharing this is one bank debit. */
  dueOn: string;
  /** What the invoice printed. */
  grossCents: number;
  /** The prompt-pay discount taken off it. */
  discountCents: number;
  /** What actually leaves the bank. Gross less the discount. */
  netCents: number;
  /** "Invoice", "Credit Memo" — what the line is, as the statement words it. */
  kind: string;
};

export type StatementRead = {
  supplier: string | null;
  /** The day the statement itself was drawn. */
  statementDate: string | null;
  /** The wholesaler's account number for this pharmacy, where it prints one. */
  accountNumber: string | null;
  lines: StatementLine[];
  /** What could not be read, verbatim, so somebody can look rather than wonder. */
  unreadable: string[];
  grossCents: number;
  discountCents: number;
  netCents: number;
};

/** One ACH debit: every line sharing a due date, which is how the bank will show it. */
export type ExpectedDebit = {
  supplier: string;
  dueOn: string;
  invoices: string[];
  grossCents: number;
  discountCents: number;
  /** The figure to look for on the bank statement. */
  netCents: number;
};

const cents = (s: string): number => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);
const MONEY = String.raw`\(?-?[\d,]+\.\d{2}\)?`;

/** MM/DD/YYYY as the statement prints it, to the ISO the rest of the site uses. */
function iso(mdy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const out = `${yyyy}-${mm}-${dd}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(out) ? out : null;
}

/** A figure in brackets is a credit, which is how this layout writes a negative. */
function signed(raw: string): number {
  const bracketed = /^\(.*\)$/.test(raw.trim());
  const n = cents(raw.replace(/[()]/g, ""));
  return bracketed ? -n : n;
}

/**
 * McKesson's statement line: two dates and the receivable number run together with no separator,
 * then an order reference, the branch, a description, and three figures.
 *
 *   08/31/202609/08/202676551031000828261404165Invoice  175.21  8,760.69  8,585.48  7655103100
 *   │         │         │         │            │        │       │         │         └ repeated
 *   billed    due       invoice   order ref    branch   discount gross    net
 */
const MCK_LINE = new RegExp(
  // Ten digits exactly. A lazy `\d{8,12}?` took eight, and every invoice sharing its first eight
  // then collapsed into one: thirty-eight lines read as six, and $126,538.20 read as $30,094.45.
  String.raw`^(\d{2}\/\d{2}\/\d{4})(\d{2}\/\d{2}\/\d{4})(\d{10})` + // billed, due, invoice number
    String.raw`(.*?)` + // order reference and branch, neither kept
    String.raw`([A-Za-z][A-Za-z ]{2,20}?)\s*` + // what the line is
    String.raw`(${MONEY})\s+(${MONEY})\s*[A-Z]?\s*(${MONEY})`, // discount, gross, net
);

export function readSupplierStatement(text: string): StatementRead {
  const lines: StatementLine[] = [];
  const unreadable: string[] = [];

  /* Their own name where they print it in full, and the abbreviation they use on the remittance stub. */
  const supplier = /mckesson/i.test(text) || /(^|[^A-Za-z])MCK([^A-Za-z]|$)/.test(text) ? "Mckesson" : null;
  const statementDate = iso(/\bDate:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? "") ?? null;
  const accountNumber = /\bCustomer:\s*(\d{4,10})/.exec(text)?.[1] ?? /\bCust:\s*(\d{4,10})/.exec(text)?.[1] ?? null;

  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    /*
     * Two dates run together is what an item line opens with, and nothing else on the page does.
     *
     * The footer opens with a date too — "08/31/2026If Paid After 09/08/2026126,538.20 USD" — and
     * testing for one date reported it as unreadable on every statement, which teaches a reader to
     * ignore the list whose whole job is to say something did not read.
     */
    if (!line || !/^\d{2}\/\d{2}\/\d{4}\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
    const m = MCK_LINE.exec(line);
    if (!m) {
      unreadable.push(line.slice(0, 200));
      continue;
    }
    const [, billedRaw, dueRaw, invoiceNumber, , kindRaw, discRaw, grossRaw, netRaw] = m;
    const billedOn = iso(billedRaw);
    const dueOn = iso(dueRaw);
    if (!billedOn || !dueOn) {
      unreadable.push(line.slice(0, 200));
      continue;
    }
    const discountCents = signed(discRaw);
    const grossCents = signed(grossRaw);
    const netCents = signed(netRaw);

    /*
     * The line's own arithmetic, which is the only thing standing between a run-together layout and
     * a plausible wrong figure against a real invoice number. A line that does not balance is kept
     * verbatim for somebody to look at rather than read as a number.
     */
    if (grossCents - discountCents !== netCents) {
      unreadable.push(line.slice(0, 200));
      continue;
    }

    /* One line per invoice. A statement repeating a page never doubles a figure. */
    const key = `${invoiceNumber}|${dueOn}`;
    if (seen.has(key)) continue;
    seen.add(key);

    lines.push({ invoiceNumber, billedOn, dueOn, grossCents, discountCents, netCents, kind: kindRaw.trim() });
  }

  return {
    supplier,
    statementDate,
    accountNumber,
    lines,
    unreadable,
    grossCents: lines.reduce((n, l) => n + l.grossCents, 0),
    discountCents: lines.reduce((n, l) => n + l.discountCents, 0),
    netCents: lines.reduce((n, l) => n + l.netCents, 0),
  };
}

/**
 * The statement grouped the way the bank will show it: one debit per due date.
 *
 * This is the whole point. A bank line of $124,007.43 matches no invoice and never will — it is
 * thirty-eight of them taken together. Grouped like this, one figure on the bank statement names
 * every invoice inside it.
 */
export function expectedDebits(read: StatementRead, supplier = read.supplier ?? "the wholesaler"): ExpectedDebit[] {
  const by = new Map<string, ExpectedDebit>();
  for (const l of read.lines) {
    const at = by.get(l.dueOn) ?? { supplier, dueOn: l.dueOn, invoices: [], grossCents: 0, discountCents: 0, netCents: 0 };
    at.invoices.push(l.invoiceNumber);
    at.grossCents += l.grossCents;
    at.discountCents += l.discountCents;
    at.netCents += l.netCents;
    by.set(l.dueOn, at);
  }
  return [...by.values()].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/**
 * Whether a document is a statement of account rather than an invoice.
 *
 * It matters because the two look alike and cost very differently if confused: an invoice is a
 * bill, a statement is a list of bills. Filing a statement as an invoice would add the whole
 * month's buying to the books a second time.
 */
export function looksLikeStatement(text: string, fileName?: string | null): boolean {
  if (/HistoricalStatement|Statement_\d{8}/i.test(fileName ?? "")) return true;
  const head = text.slice(0, 4000);
  /* Its own word for itself, plus the column heading no invoice has. */
  return /\bSTATEMENT\b/i.test(head) && /Receivable\s*\n?\s*Number|Billing\s*Due|Statement for information only/i.test(head);
}
