import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { readSupplierStatement, type StatementRead } from "./supplier-statement";

/**
 * Keeps what a wholesaler's statement of account says, so the bank can be matched against it.
 *
 * The reader (supplier-statement.ts) has existed since the first statement arrived; the mailbox recognised a
 * statement, re-titled the document, and stored nothing it read. So the one key that ties a McKesson ACH to the
 * invoices inside it — every line sharing a due date is one debit, net of the prompt-pay discount, less that
 * week's return credits — sat in a PDF nobody consulted. On 1 October 2026 the owner dropped in the statement as
 * of 25 September: 42 invoices net $135,383.37 less $13,385.96 of credits is $121,997.41, which is the 29
 * September debit to the cent, and the site had called that debit "no open invoice of theirs is for this amount".
 *
 * Lines go into `supplier_statement_lines`, the same ledger the accounts-payable report fills, keyed the same way
 * (supplier, invoice number, due date). The statement knows less than the AP report — no check number, no clearing
 * date — so a row the report has already settled keeps those; the statement only ever adds or refreshes figures.
 */
export async function storeSupplierStatement(read: StatementRead, documentId: string | null): Promise<{ written: number; updated: number; says: string }> {
  const supplier = read.supplier;
  if (!supplier) return { written: 0, updated: 0, says: "The statement names no wholesaler this site knows; nothing was kept from it." };
  let written = 0;
  let updated = 0;
  for (const l of read.lines) {
    const where = and(eq(schema.supplierStatementLines.supplier, supplier), eq(schema.supplierStatementLines.invoiceNumber, l.invoiceNumber), eq(schema.supplierStatementLines.dueOn, l.dueOn));
    const held = await db.query.supplierStatementLines.findFirst({ where });
    const values = {
      billedOn: l.billedOn,
      grossCents: l.grossCents,
      discountCents: l.discountCents,
      netCents: l.netCents,
      kind: l.kind || "Invoice",
      statementDate: read.statementDate,
      readAt: new Date().toISOString(),
    };
    if (held) {
      await db.update(schema.supplierStatementLines).set({ ...values, documentId: held.documentId ?? documentId }).where(where);
      updated++;
    } else {
      await db.insert(schema.supplierStatementLines).values({ id: newId(), supplier, invoiceNumber: l.invoiceNumber, dueOn: l.dueOn, checkNumber: null, clearingDate: null, clearingDocument: null, status: "Open", documentId, ...values });
      written++;
    }
  }
  const byDue = new Map<string, number>();
  for (const l of read.lines) byDue.set(l.dueOn, (byDue.get(l.dueOn) ?? 0) + l.netCents);
  const debits = [...byDue].sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => `${(c / 100).toFixed(2)} due ${d}`);
  return {
    written,
    updated,
    says: `${supplier}'s statement as of ${read.statementDate ?? "an unknown date"}: ${read.lines.length} lines, ${written} new and ${updated} already held${read.unreadable.length ? `, ${read.unreadable.length} unreadable` : ""}. The bank will take ${debits.join("; ")}.`,
  };
}

/** Reads and keeps a statement from its text, for the mailbox and the intake. */
export async function keepStatementText(text: string, documentId: string | null): Promise<{ written: number; updated: number; says: string }> {
  return storeSupplierStatement(readSupplierStatement(text), documentId);
}
