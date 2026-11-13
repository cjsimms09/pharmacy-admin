import { db } from "@/db";

/**
 * What each wholesaler's statement of account says the bank will take, by due date: the invoices due that day that
 * the statement lists, net of discount, less the credits the same statement lists (whatever "due" date a credit
 * prints — McKesson's 25 September returns came off the 29 September draw), and never an invoice some other line
 * already paid. Rows the accounts-payable report alone put in the ledger carry no statement date and form no
 * group: that report's ACH numbers settle them instead.
 *
 * Read by the bank matcher (a debit equal to a group settles it) and by Cash ahead (the group is a known outflow).
 */
export type StatementDebit = { supplier: string; dueOn: string; statementDate: string; netCents: number; invoices: string[] };

export async function openStatementDebits(): Promise<StatementDebit[]> {
  const rows = await db.query.supplierStatementLines.findMany({ columns: { supplier: true, invoiceNumber: true, dueOn: true, netCents: true, checkNumber: true, clearingDocument: true, statementDate: true } });
  const paid = new Set((await db.query.supplierInvoices.findMany({ columns: { invoiceNumber: true, paidOn: true } })).filter((v) => v.paidOn && v.invoiceNumber).map((v) => v.invoiceNumber!));
  const open = rows.filter((r) => !r.checkNumber && !r.clearingDocument && r.statementDate);
  const byDue = new Map<string, StatementDebit>();
  for (const r of open) {
    if (r.netCents <= 0 || paid.has(r.invoiceNumber)) continue;
    const k = `${r.supplier.toLowerCase()}|${r.statementDate}|${r.dueOn}`;
    const g = byDue.get(k) ?? { supplier: r.supplier, dueOn: r.dueOn, statementDate: r.statementDate!, netCents: 0, invoices: [] };
    g.netCents += r.netCents;
    g.invoices.push(r.invoiceNumber);
    byDue.set(k, g);
  }
  for (const g of byDue.values()) {
    for (const c of open) if (c.netCents < 0 && c.supplier.toLowerCase() === g.supplier.toLowerCase() && c.statementDate === g.statementDate && c.dueOn <= g.dueOn) g.netCents += c.netCents;
  }
  return [...byDue.values()].filter((g) => g.netCents > 0).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}
