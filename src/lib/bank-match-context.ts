import "server-only";
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { type MatchContext } from "./bank-statement";
import { unpaid, vendors } from "./expenses";
import { allSuppliers } from "./suppliers-registry";
import { CARD_STATEMENT_BILL } from "./card-statement";

/**
 * What the matcher needs to know about the business, read once per statement.
 *
 * Lifted out of the money page's server actions so that the page, the nightly pass and any proof of
 * the reconciliation all build the context the same way. It was private to one file, which meant a
 * check written against it could only ever be a second implementation of it — and a second
 * implementation of a money rule is how two figures that should be one start to disagree.
 */
export async function matchContext(): Promise<MatchContext> {
  const [claims, sup, ven, bills, invoices, receipts] = await Promise.all([
    db.query.claims.findMany({ columns: { pbmName: true, payerLabel: true } }),
    allSuppliers(true),
    vendors(),
    unpaid(),
    db.query.supplierInvoices.findMany({ columns: { id: true, invoiceNumber: true, supplierId: true, supplier: true, totalCents: true, invoiceDate: true, paidOn: true } }),
    db.query.cashReceipts.findMany({ columns: { payer: true } }),
  ]);
  const payers = new Set<string>();
  for (const c of claims) for (const n of [c.pbmName, c.payerLabel]) if (n && n.trim().length >= 4) payers.add(n.trim());
  for (const r of receipts) if (r.payer && r.payer.trim().length >= 4) payers.add(r.payer.trim());
  const vendorName = new Map(ven.map((v) => [v.id, v.name]));
  /* The card statement's fee bills no bank line has claimed. Booked already paid, so `unpaid()` never returns them. */
  const claimedBills = new Set((await db.query.bankLines.findMany({ columns: { expenseId: true } })).map((r) => r.expenseId).filter((id): id is string => id !== null));
  const cardFeeBills = (await db.query.expenses.findMany({ where: and(like(schema.expenses.invoiceNumber, `${CARD_STATEMENT_BILL}%`), eq(schema.expenses.status, "confirmed")) }))
    .filter((b) => !claimedBills.has(b.id))
    .map((b) => ({ id: b.id, vendorName: b.vendorId ? vendorName.get(b.vendorId) ?? null : null, amountCents: b.amountCents, invoiceDate: b.invoiceDate }));
  /* The wholesaler's own ledger: what each ACH reference covered. What a McKesson debit is placed by. */
  const statementLines = (await db.query.supplierStatementLines.findMany({ columns: { supplier: true, invoiceNumber: true, checkNumber: true, netCents: true } }))
    .filter((l) => l.checkNumber)
    .filter((l, i, all) => all.findIndex((x) => x.supplier === l.supplier && x.invoiceNumber === l.invoiceNumber && x.checkNumber === l.checkNumber) === i);
  const facilitatorByDay = new Map<string, number>();
  for (const p of await db.query.claimPayments.findMany({ where: eq(schema.claimPayments.source, "mtf"), columns: { receivedOn: true, amountCents: true } })) {
    if (p.receivedOn) facilitatorByDay.set(p.receivedOn, (facilitatorByDay.get(p.receivedOn) ?? 0) + p.amountCents);
  }
  const postageBills = (await db.query.expenses.findMany({ where: and(like(schema.expenses.invoiceNumber, "POSTAGE|%"), eq(schema.expenses.status, "confirmed")), columns: { amountCents: true, paidOn: true, invoiceDate: true } }))
    .map((b) => ({ amountCents: b.amountCents, on: b.paidOn ?? b.invoiceDate }));
  /*
   * Payments to suppliers the site already holds with the invoices inside them.
   *
   * A Parmed ACH pays a fortnight of invoices at once and an IPD one pays whatever its Aytu credit did not, so no single
   * invoice ever equals the debit and the amount rules would leave every one of them unplaced. Where the portal page or
   * the statement has been read, each part is already counted in the month it was paid, so the bank line confirms it.
   */
  const payments = await db.query.supplierPayments.findMany({ columns: { id: true, supplier: true, paidOn: true, amountCents: true } });
  const allocationCount = new Map<string, number>();
  for (const a of await db.query.supplierPaymentAllocations.findMany({ columns: { paymentId: true } })) {
    allocationCount.set(a.paymentId, (allocationCount.get(a.paymentId) ?? 0) + 1);
  }
  /* PioneerRx receiving, as payables: the pool that actually covers the deliveries. */
  const receiving = await db.query.pioneerPurchases.findMany({ columns: { id: true, invoiceNumber: true, supplier: true, totalCents: true, invoiceDate: true } });

  return {
    receipts: receiving.map((r) => ({ id: r.id, number: r.invoiceNumber ?? r.id.slice(0, 8), supplier: r.supplier, totalCents: r.totalCents, invoiceDate: r.invoiceDate })),
    postageBills,
    supplierPayments: payments.map((p) => ({ id: p.id, supplier: p.supplier, paidOn: p.paidOn, amountCents: p.amountCents, invoices: allocationCount.get(p.id) ?? 0 })),
    facilitatorPaid: [...facilitatorByDay].map(([on, cents]) => ({ on, cents })),
    payers: [...payers],
    suppliers: sup.map((s) => ({ id: s.id, name: s.name, accountNumber: s.accountNumber ?? null })),
    vendors: ven.map((v) => ({ id: v.id, name: v.name })),
    unpaidBills: bills.map((b) => ({ id: b.id, vendorId: b.vendorId, vendorName: b.vendorId ? vendorName.get(b.vendorId) ?? null : null, amountCents: b.amountCents, invoiceDate: b.invoiceDate })),
    cardFeeBills,
    settled: statementLines,
    unpaidInvoices: invoices.filter((v) => !v.paidOn).map((v) => ({ id: v.id, invoiceNumber: v.invoiceNumber, supplierId: v.supplierId, supplier: v.supplier, totalCents: v.totalCents, invoiceDate: v.invoiceDate })),
  };
}
