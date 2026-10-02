/**
 * ParMed's "Statement & Remittance": every invoice still open, what is owed on it, and when it is due.
 *
 * It arrived on 1 October 2026 and was filed as "a PDF this does not recognise" — $5,877.21 of
 * accounts payable with eighteen due dates on it, and nothing read a line.
 *
 * ── Why it was missed, which is the more useful half ──
 *
 * Not because the reader was wrong. Because there was no reader, and there was no reader because the
 * document never reached one: it came from `donotreply@parmedpharm.com`, and the register knew ParMed
 * only as `noreply@parmedpharm.com` and `gmb-parmed-customercare@parmedpharm.com`. With no supplier
 * matched, `classifySupplierDocument` is never consulted and the file falls through to the vault.
 *
 * So this recognises the page by what is printed on it, as `autoroute` says every rule here should:
 * "recognition is done by reading the file's own header row rather than trusting its name". The
 * sender is then irrelevant, and the fourth address ParMed invents costs nothing. (Its EFT debit
 * notice already worked from that same unknown address for exactly this reason.)
 *
 * ── The shape ──
 *
 *   Statement & Remittance
 *   Statement Date Stmt Ref  Payer
 *   09/30/2026  <stmt ref>  <customer no>
 *   ...
 *   <invoice no><payer no>INV<invoice date><PO><due date>( )<invoice no>
 *   <amount> <payment made> <discount> <balance due> <invoice balance due>
 *   ...
 *   CurrentFuture1-15 days16-30 days31-45 daysOver 45 daysTotal Balance
 *   5,877.21 0.00 0.00 0.00 0.00 0.00 5,877.21
 *
 * Every row is two printed lines and every column runs into the next, so the row is read off the
 * payer number the header gives — and the invoice number is printed twice, at both ends of the first
 * line, which is a free check that the split landed where it should. A row whose two copies disagree
 * is not read.
 *
 * ── The gate ──
 *
 * The balances due are added here and compared with the Total Balance the page prints. A statement
 * whose rows miss its own total yields nothing: these figures are what the pharmacy owes and when,
 * and a partial reading of them is worse than none, because it looks like the whole.
 *
 * Pure. `parmed-statement-store.ts` writes.
 */

export type ParmedStatementRow = {
  invoiceNumber: string;
  /** ISO. The day ParMed billed it. */
  billedOn: string;
  /** ISO. The day the statement says it falls due — the fact nothing else on file carries. */
  dueOn: string;
  /** "INV", or whatever the page prints in the transaction-type column. */
  kind: string;
  grossCents: number;
  paidCents: number;
  discountCents: number;
  /** What is still owed on this invoice. The column the total is made of. */
  netCents: number;
};

export type ParmedStatement = {
  /** ISO. The day the statement was drawn. */
  statementOn: string;
  /** ParMed's own reference for this statement. */
  reference: string | null;
  /** ParMed's customer number for this pharmacy. Its identity, with the date. */
  customerNumber: string;
  rows: ParmedStatementRow[];
  /** The rows' balances, added here, having agreed with the printed total. */
  totalCents: number;
  /** The ageing bands as printed, so what is overdue is read rather than worked out from today. */
  ageing: { current: number; future: number; days1to15: number; days16to30: number; days31to45: number; over45: number } | null;
};

const iso = (mdy: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/** A figure, with a parenthesised one read as the credit it is. */
const cents = (s: string): number => {
  const negative = /^\(.*\)$/.test(s.trim());
  const n = Number(s.replace(/[(),$]/g, ""));
  return Math.round((negative ? -n : n) * 100);
};

export function looksLikeParmedStatement(text: string): boolean {
  return /Statement\s*&\s*Remittance/i.test(text) && /ParMed/i.test(text) && /Total Balance/i.test(text);
}

/** The two printed lines of one row: identifiers and dates, then the five money columns. */
const HEAD = /^(\d{6,})([A-Z]{2,4})(\d{2}\/\d{2}\/\d{4})(.*?)(\d{2}\/\d{2}\/\d{4})\s*\([^)]*\)\s*(\d{6,})\s*$/;
const MONEY_LINE = /^\s*(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s*$/;

export function readParmedStatement(text: string): ParmedStatement | null {
  if (!looksLikeParmedStatement(text)) return null;
  const lines = text.split(/\r?\n/);

  /* "09/30/2026  <stmt ref>  <customer no>" — the date, ParMed's reference, and the customer number. */
  let statementOn = "";
  let reference: string | null = null;
  let customerNumber = "";
  for (const line of lines) {
    const m = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+(\d{6,})\s*$/.exec(line);
    if (!m) continue;
    statementOn = iso(m[1]) ?? "";
    reference = m[2];
    customerNumber = m[3];
    break;
  }
  if (!statementOn || !customerNumber) return null;

  const rows: ParmedStatementRow[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const head = HEAD.exec(lines[i].trim());
    if (!head) continue;
    /*
     * The leading run is the invoice number and the customer number together, and the invoice number
     * is printed again at the end of the same line. Splitting on the customer number and then
     * requiring the two copies to agree is what makes the split safe rather than assumed.
     */
    const run = head[1];
    if (!run.endsWith(customerNumber)) continue;
    const invoiceNumber = run.slice(0, run.length - customerNumber.length);
    if (invoiceNumber !== head[6]) continue;

    const kind = head[2];
    const billedOn = iso(head[3]);
    const dueOn = iso(head[5]);
    if (!billedOn || !dueOn) continue;

    const money = MONEY_LINE.exec(lines[i + 1] ?? "");
    if (!money) continue;

    rows.push({
      invoiceNumber,
      billedOn,
      dueOn,
      kind,
      grossCents: cents(money[1]),
      paidCents: cents(money[2]),
      discountCents: cents(money[3]),
      netCents: cents(money[4]),
    });
  }
  if (rows.length === 0) return null;

  /* "5,877.21 0.00 0.00 0.00 0.00 0.00 5,877.21" — six bands and the total. */
  let ageing: ParmedStatement["ageing"] = null;
  let printedTotal: number | null = null;
  for (const line of lines) {
    const m = /^\s*(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{2}\)?)\s*$/.exec(line);
    if (!m) continue;
    ageing = {
      current: cents(m[1]),
      future: cents(m[2]),
      days1to15: cents(m[3]),
      days16to30: cents(m[4]),
      days31to45: cents(m[5]),
      over45: cents(m[6]),
    };
    printedTotal = cents(m[7]);
  }
  if (printedTotal === null) return null;

  const added = rows.reduce((n, r) => n + r.netCents, 0);
  if (added !== printedTotal) return null;

  return { statementOn, reference, customerNumber, rows, totalCents: added, ageing };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the statement says, for the inbox line. */
export function describeParmedStatement(s: ParmedStatement, notOnFile: string[] = []): string {
  const due = s.rows.map((r) => r.dueOn).sort();
  const overdue = s.ageing ? s.ageing.days1to15 + s.ageing.days16to30 + s.ageing.days31to45 + s.ageing.over45 : 0;
  return (
    `ParMed says ${money(s.totalCents)} is open across ${s.rows.length} invoice${s.rows.length === 1 ? "" : "s"}, due ${due[0]} to ${due[due.length - 1]}. ` +
    `Its rows add up to the total it prints, so the figure is proved rather than read. ` +
    `${overdue === 0 ? "None of it is past due by their own ageing." : `${money(overdue)} of it is past due by their own ageing.`}` +
    `${notOnFile.length ? ` ${notOnFile.length} of the invoices it bills for ${notOnFile.length === 1 ? "is" : "are"} not on file here: ${notOnFile.slice(0, 6).join(", ")}${notOnFile.length > 6 ? "…" : ""}.` : " Every invoice it names is on file."}`
  );
}

/**
 * The statement as the supplier-statement store keeps it (supplier-statement.ts): one line per open invoice with the
 * day it falls due, under the supplier's name as the invoices carry it, so Parmed's draws can be placed by statement
 * group and Cash ahead can see them coming. Only what is still owed goes in: a paid row has nothing to draw.
 */
export function statementReadOf(s: ParmedStatement): import("./supplier-statement").StatementRead {
  const lines = s.rows
    .filter((r) => r.netCents > 0)
    .map((r) => ({ invoiceNumber: r.invoiceNumber, billedOn: r.billedOn, dueOn: r.dueOn, grossCents: r.grossCents, discountCents: r.discountCents, netCents: r.netCents, kind: r.kind }));
  return {
    supplier: "Parmed",
    statementDate: s.statementOn,
    accountNumber: s.customerNumber,
    lines,
    unreadable: [],
    grossCents: lines.reduce((n, l) => n + l.grossCents, 0),
    discountCents: lines.reduce((n, l) => n + l.discountCents, 0),
    netCents: lines.reduce((n, l) => n + l.netCents, 0),
  };
}
