/**
 * McKesson's Accounts Payable Transaction History export.
 *
 * The owner sent it on 1 October 2026 to be read every month. It is the third McKesson document that lists
 * invoices with their figures, and it is worth being exact about what it carries and what it does not:
 *
 *   Open & Closed Transactions   invoices with the ACH each cleared under — the key to a bank debit. Weekly.
 *   Statement of account (PDF)   invoices due at the next draw, net of discount, with that week's credits.
 *   Transaction History (this)   invoices with their dates and figures. No check number, no clearing date,
 *                                no status: it says what was billed and when it is due, and nothing about
 *                                whether or how it was paid.
 *
 * So it is read as a statement is read — rows into the same ledger, keyed the same way — and it can never
 * settle a bank line by itself; the statement's grouping and the Open & Closed report's ACH numbers do that.
 *
 * ── The columns, and which is which ──
 *
 * Three money columns, named so that the obvious reading is wrong: "Purchase History Extended Price ($)" is the
 * NET after the cash discount, and "Accounts Payable (Gross Amount) $" is the gross before it — $7,466.98 and
 * $7,619.37 against a discount of $152.39 on the first row read. Gross less discount is net on every row, or
 * the row is not read; that arithmetic is the only thing that proves the columns were taken the right way round.
 *
 * Pure. The totals sheet that travels with it ("total_amount_$_(gross).csv") is a one-cell sum and is left alone.
 */
import type { StatementLine, StatementRead } from "./supplier-statement";

/* A CSV with quoted money cells, read without the server-only reference module so the reader stays pure and testable. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const cents = (s: string | undefined): number | null => {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

export function looksLikeApHistory(head: string): boolean {
  const first = head.split("\n")[0] ?? "";
  return /Receivable Number/i.test(first) && /Transaction Posting Date/i.test(first) && /Accounts Payable \(Gross Amount\)/i.test(first) && !/Transaction Status/i.test(first);
}

/** Reads the history into the statement's own shape, so one store keeps both. `asOf` is the day it was sent. */
export function readApHistory(csv: string, asOf: string | null): StatementRead {
  const rows = parseCsv(csv);
  const lines: StatementLine[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const invoiceNumber = (r["Receivable Number"] ?? "").trim();
    const billedOn = (r["Transaction Date"] ?? "").trim();
    const dueOn = (r["Due Date"] ?? "").trim();
    const gross = cents(r["Accounts Payable (Gross Amount) $"]);
    const discount = cents(r["Cash Discount ($)"]);
    const net = cents(r["Purchase History Extended Price ($)"]);
    const kind = (r["Transaction Type"] ?? "Invoice").trim();
    if (!/^\d{6,}$/.test(invoiceNumber) || !/^\d{4}-\d{2}-\d{2}$/.test(billedOn) || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || gross === null || discount === null || net === null) {
      unreadable.push(JSON.stringify(r).slice(0, 200));
      continue;
    }
    if (gross - discount !== net) {
      unreadable.push(`${invoiceNumber}: gross ${gross} less discount ${discount} is not net ${net}`);
      continue;
    }
    const key = `${invoiceNumber}|${dueOn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    /* A credit prints its kind as such; its figures come signed from the export, or not at all. */
    const sign = /credit|return/i.test(kind) && net > 0 ? -1 : 1;
    lines.push({ invoiceNumber, billedOn, dueOn, grossCents: sign * gross, discountCents: sign * discount, netCents: sign * net, kind });
  }
  return {
    supplier: "Mckesson",
    statementDate: asOf,
    accountNumber: null,
    lines,
    unreadable,
    grossCents: lines.reduce((n, l) => n + l.grossCents, 0),
    discountCents: lines.reduce((n, l) => n + l.discountCents, 0),
    netCents: lines.reduce((n, l) => n + l.netCents, 0),
  };
}
