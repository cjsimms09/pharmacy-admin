import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { audit } from "./audit";
import { checkAllocations, type ProposedAllocation } from "./paid-together";
import type { SUPPLIER_PAYMENT_BASES, SUPPLIER_PAYMENT_METHODS, SUPPLIER_PAYMENT_SOURCES } from "@/db/schema";

/**
 * Payments to suppliers, and what each one put against each invoice.
 *
 * A paid date on an invoice is one day per invoice, and it cannot hold what these suppliers actually do: Parmed takes one
 * ACH for a half-month of invoices, and IPD settles invoices by offset against an Aytu credit memo, sometimes paying one
 * invoice across two offsets. The cash account counts each allocation in the month of its payment (`cash-cogs.ts`), so
 * the amount per invoice is the fact that has to be kept.
 *
 * `supplier_invoices.paid_on` is derived here and nowhere else in this file's path: an invoice is paid on the day its
 * allocations reach its total, and until then it has no paid date and is part paid. A date the bank statement put there
 * for a single invoice it matched stays as it is — that invoice has no allocations.
 *
 * Every payment carries a source key, so reading the same statement or portal page twice writes nothing the second time,
 * and can be removed again with `removeSupplierPayment`.
 */

export type NewSupplierPayment = {
  supplier: string;
  paidOn: string;
  amountCents: number;
  method?: (typeof SUPPLIER_PAYMENT_METHODS)[number];
  reference?: string | null;
  creditMemo?: string | null;
  source: (typeof SUPPLIER_PAYMENT_SOURCES)[number];
  basis?: (typeof SUPPLIER_PAYMENT_BASES)[number];
  sourceKey: string;
  documentId?: string | null;
  notes?: string | null;
  allocations: ProposedAllocation[];
  /** True where the payment is allowed to differ from what it put against invoices: a discount, or a credit taken. */
  acceptDifference?: boolean;
};

export type RecordedPayment = { ok: true; paymentId: string; alreadyHeld: boolean; says: string } | { ok: false; why: string };

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The day an invoice's allocations finish paying it, or null while they do not.
 *
 * Read from the allocations every time rather than added to as they arrive, so removing a payment cannot leave a paid
 * date behind it. An invoice with no allocations is not touched: its date, where it has one, came from the bank
 * statement matching a debit to that one invoice, or from a person typing it on the row.
 */
async function refreshPaidOn(invoiceIds: string[]): Promise<void> {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return;
  const invoices = await db.query.supplierInvoices.findMany({ where: inArray(schema.supplierInvoices.id, ids), columns: { id: true, totalCents: true, paidOn: true } });
  const allocations = await db
    .select({ invoiceId: schema.supplierPaymentAllocations.invoiceId, amountCents: schema.supplierPaymentAllocations.amountCents, paidOn: schema.supplierPayments.paidOn })
    .from(schema.supplierPaymentAllocations)
    .innerJoin(schema.supplierPayments, eq(schema.supplierPaymentAllocations.paymentId, schema.supplierPayments.id))
    .where(inArray(schema.supplierPaymentAllocations.invoiceId, ids));
  for (const v of invoices) {
    const mine = allocations.filter((a) => a.invoiceId === v.id).sort((a, b) => a.paidOn.localeCompare(b.paidOn));
    if (mine.length === 0) continue;
    const total = v.totalCents ?? 0;
    let running = 0;
    let paidOn: string | null = null;
    for (const a of mine) {
      running += a.amountCents;
      if (total > 0 && running >= total) {
        paidOn = a.paidOn;
        break;
      }
    }
    if (paidOn !== v.paidOn) await db.update(schema.supplierInvoices).set({ paidOn }).where(eq(schema.supplierInvoices.id, v.id));
  }
}

/** What a payment has already put against each of these invoices, so a second payment cannot allocate the same money twice. */
async function allocatedAlready(invoiceIds: string[], exceptPaymentId?: string): Promise<Map<string, number>> {
  const rows = invoiceIds.length
    ? await db
        .select({ invoiceId: schema.supplierPaymentAllocations.invoiceId, amountCents: schema.supplierPaymentAllocations.amountCents, paymentId: schema.supplierPaymentAllocations.paymentId })
        .from(schema.supplierPaymentAllocations)
        .where(inArray(schema.supplierPaymentAllocations.invoiceId, [...new Set(invoiceIds)]))
    : [];
  const by = new Map<string, number>();
  for (const r of rows) {
    if (exceptPaymentId && r.paymentId === exceptPaymentId) continue;
    by.set(r.invoiceId, (by.get(r.invoiceId) ?? 0) + r.amountCents);
  }
  return by;
}

export async function recordSupplierPayment(input: NewSupplierPayment, user: { name: string; id?: string }): Promise<RecordedPayment> {
  const held = await db.query.supplierPayments.findFirst({ where: eq(schema.supplierPayments.sourceKey, input.sourceKey), columns: { id: true, paidOn: true, amountCents: true } });
  if (held) {
    return { ok: true, paymentId: held.id, alreadyHeld: true, says: `That payment of ${money(held.amountCents)} on ${held.paidOn} is already on file; nothing was written again.` };
  }

  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  const invoices = invoiceIds.length
    ? await db.query.supplierInvoices.findMany({
        where: inArray(schema.supplierInvoices.id, [...new Set(invoiceIds)]),
        columns: { id: true, supplier: true, invoiceNumber: true, totalCents: true, paidOn: true },
      })
    : [];
  /*
   * A payment that names no invoice this site holds is still a payment.
   *
   * IPD's statement settles invoices older than the invoice feed: on the owner's own statement, all 14 of them. The
   * money moved and the credit that moved it has to be banked, so the payment is written with nothing against it rather
   * than refused — its cost reaches no month, which is right, because those invoices were never counted either. Only a
   * document that says so may do this: `acceptDifference` is how the caller says the difference is accounted for.
   */
  const namesNothing = input.allocations.length === 0 && (input.acceptDifference ?? false);
  const check = namesNothing
    ? ({ ok: true, supplier: input.supplier, allocatedCents: 0, differenceCents: input.amountCents } as const)
    : checkAllocations({
        invoices,
        allocations: input.allocations,
        allocatedAlready: Object.fromEntries(await allocatedAlready(invoiceIds)),
        paidOn: input.paidOn,
        paymentCents: input.amountCents,
        acceptDifference: input.acceptDifference ?? false,
      });
  if (!check.ok) return check;

  const paymentId = newId();
  await db.insert(schema.supplierPayments).values({
    id: paymentId,
    supplier: check.supplier,
    paidOn: input.paidOn,
    amountCents: input.amountCents,
    method: input.method ?? "unknown",
    reference: input.reference ?? null,
    creditMemo: input.creditMemo ?? null,
    source: input.source,
    basis: input.basis ?? "document",
    sourceKey: input.sourceKey,
    documentId: input.documentId ?? null,
    notes: input.notes ?? null,
    createdBy: user.name,
  });
  for (const a of input.allocations) {
    await db.insert(schema.supplierPaymentAllocations).values({ id: newId(), paymentId, invoiceId: a.invoiceId, amountCents: a.amountCents });
  }
  await refreshPaidOn(invoiceIds);

  const paid = await db.query.supplierInvoices.findMany({ where: inArray(schema.supplierInvoices.id, [...new Set(invoiceIds)]), columns: { id: true, paidOn: true } });
  const finished = paid.filter((v) => v.paidOn === input.paidOn).length;
  const part = paid.length - finished;
  const difference = check.differenceCents === 0 ? "" : ` The payment is ${money(Math.abs(check.differenceCents))} ${check.differenceCents > 0 ? "more" : "less"} than it put against invoices, recorded as a discount or credit.`;
  const says =
    `${money(input.amountCents)} to ${check.supplier} on ${input.paidOn}, against ${input.allocations.length} invoice${input.allocations.length === 1 ? "" : "s"}` +
    `${part ? ` (${finished} paid in full, ${part} part paid)` : ""}.${difference} The cash account counts it in ${input.paidOn.slice(0, 7)}.`;
  await audit({
    action: "supplier_payment.recorded",
    userId: user.id ?? null,
    userName: user.name,
    entity: "supplier_payment",
    entityId: paymentId,
    details: `${check.supplier} ${money(input.amountCents)} ${input.paidOn} (${input.source}, ${input.basis ?? "document"}${input.reference ? `, ref ${input.reference}` : ""}): ${input.allocations.length} invoices`,
  });
  return { ok: true, paymentId, alreadyHeld: false, says };
}

/** Takes a payment back out, with its allocations, and the paid dates they set. */
export async function removeSupplierPayment(id: string, user: { name: string; id?: string }): Promise<{ ok: boolean; says: string }> {
  const payment = await db.query.supplierPayments.findFirst({ where: eq(schema.supplierPayments.id, id) });
  if (!payment) return { ok: false, says: "That payment is no longer on file." };
  const rows = await db.query.supplierPaymentAllocations.findMany({ where: eq(schema.supplierPaymentAllocations.paymentId, id), columns: { invoiceId: true } });
  const invoiceIds = rows.map((r) => r.invoiceId);
  await db.delete(schema.supplierPaymentAllocations).where(eq(schema.supplierPaymentAllocations.paymentId, id));
  await db.delete(schema.supplierPayments).where(eq(schema.supplierPayments.id, id));
  await refreshPaidOn(invoiceIds);
  await audit({
    action: "supplier_payment.removed",
    userId: user.id ?? null,
    userName: user.name,
    entity: "supplier_payment",
    entityId: id,
    details: `${payment.supplier} ${money(payment.amountCents)} ${payment.paidOn} (${payment.source}): ${invoiceIds.length} invoices freed`,
  });
  return {
    ok: true,
    says: `The ${money(payment.amountCents)} payment to ${payment.supplier} on ${payment.paidOn} is removed, and the ${invoiceIds.length} invoice${invoiceIds.length === 1 ? "" : "s"} it paid ${invoiceIds.length === 1 ? "is" : "are"} open again.`,
  };
}

export type SupplierPaymentRow = {
  id: string;
  supplier: string;
  paidOn: string;
  amountCents: number;
  method: string;
  basis: string;
  source: string;
  reference: string | null;
  creditMemo: string | null;
  invoices: { invoiceId: string; invoiceNumber: string | null; amountCents: number; totalCents: number | null; paidInFull: boolean }[];
};

/** Every payment on file, newest first, with what it paid. For the invoices page. */
export async function supplierPayments(limit = 50): Promise<SupplierPaymentRow[]> {
  const payments = await db.query.supplierPayments.findMany({ columns: { id: true, supplier: true, paidOn: true, amountCents: true, method: true, basis: true, source: true, reference: true, creditMemo: true } });
  if (payments.length === 0) return [];
  const rows = await db
    .select({
      paymentId: schema.supplierPaymentAllocations.paymentId,
      invoiceId: schema.supplierPaymentAllocations.invoiceId,
      amountCents: schema.supplierPaymentAllocations.amountCents,
      invoiceNumber: schema.supplierInvoices.invoiceNumber,
      totalCents: schema.supplierInvoices.totalCents,
      paidOn: schema.supplierInvoices.paidOn,
    })
    .from(schema.supplierPaymentAllocations)
    .leftJoin(schema.supplierInvoices, eq(schema.supplierPaymentAllocations.invoiceId, schema.supplierInvoices.id));
  return payments
    .sort((a, b) => b.paidOn.localeCompare(a.paidOn))
    .slice(0, limit)
    .map((p) => ({
      ...p,
      invoices: rows
        .filter((r) => r.paymentId === p.id)
        .map((r) => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber ?? null, amountCents: r.amountCents, totalCents: r.totalCents ?? null, paidInFull: r.paidOn !== null })),
    }));
}

/**
 * A wholesaler's debit, turned into a payment where the invoices themselves say it paid them.
 *
 * Called by the bank statement when a debit to a supplier finds no payment already on file. The bank says what left and
 * on which day; the invoices say which of them were due then (`invoice-due-date.ts`); this writes a payment only when
 * those two agree to the cent, and otherwise writes nothing and says what it saw, so the supplier's own payment page is
 * what settles it. Idempotent on the bank line's key, so re-reading a statement writes nothing twice.
 *
 * Never for a supplier whose own ledger the site reads: there the ledger says what cleared and under which ACH, and a
 * payment written here would be the same money a second time (`cash-cogs.ts`).
 */
export async function paymentFromBankDebit(
  input: { supplier: string; on: string; amountCents: number; bankLineKey: string; reference?: string | null },
  user: { name: string; id?: string },
): Promise<{ ok: true; paymentId: string; alreadyHeld: boolean; says: string } | { ok: false; why: string }> {
  const { invoicesDueForDebit } = await import("./paid-together");
  const fold = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  /*
   * This line first, before the invoices are looked at.
   *
   * Re-reading a statement asks about a line whose payment is already on file, and its invoices are paid — by this very
   * payment. Asking the invoices first answered "they are already paid, so this is not what paid them", which is true of
   * a second debit and nonsense about the same one. Found on the rehearsal, re-reading one statement.
   */
  const sourceKey = `bank_debit|${input.bankLineKey}`;
  const held = await db.query.supplierPayments.findFirst({ where: eq(schema.supplierPayments.sourceKey, sourceKey), columns: { id: true, paidOn: true, amountCents: true } });
  if (held) {
    return { ok: true, paymentId: held.id, alreadyHeld: true, says: `That debit of ${money(held.amountCents)} on ${held.paidOn} is already on file as a payment; nothing was written again.` };
  }

  const ledgerFed = (await db.selectDistinct({ supplier: schema.supplierStatementLines.supplier }).from(schema.supplierStatementLines)).some((l) => fold(l.supplier) === fold(input.supplier));
  if (ledgerFed) return { ok: false, why: `${input.supplier}'s own ledger says what each ACH covered, so nothing is written from the bank line` };

  const invoices = (await db.query.supplierInvoices.findMany({ columns: { id: true, supplier: true, invoiceNumber: true, totalCents: true, paidOn: true, dueOn: true } })).filter(
    (v) => fold(v.supplier) === fold(input.supplier),
  );
  const already = await allocatedAlready(invoices.map((v) => v.id));
  const chosen = invoicesDueForDebit({
    invoices: invoices.map((v) => ({ ...v, allocatedCents: already.get(v.id) ?? 0 })),
    on: input.on,
    amountCents: input.amountCents,
  });
  if (!chosen.ok) return chosen;

  return recordSupplierPayment(
    {
      supplier: input.supplier,
      paidOn: input.on,
      amountCents: input.amountCents,
      method: "ach",
      reference: input.reference ?? null,
      source: "bank_debit",
      /* Every part of it is printed: the invoices name the day they are due, and the bank names the money. */
      basis: "document",
      sourceKey,
      notes: `From the bank statement: ${chosen.invoices.length} invoice${chosen.invoices.length === 1 ? "" : "s"} printing a due date within three days of ${input.on}, coming to the debit exactly.`,
      allocations: chosen.invoices.map((v) => ({ invoiceId: v.id, amountCents: v.totalCents ?? 0 })),
    },
    user,
  );
}

/** What each invoice has been paid so far, for the invoice rows: id → cents allocated. */
export async function allocatedByInvoice(): Promise<Map<string, number>> {
  const rows = await db.select({ invoiceId: schema.supplierPaymentAllocations.invoiceId, amountCents: schema.supplierPaymentAllocations.amountCents }).from(schema.supplierPaymentAllocations);
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.invoiceId, (by.get(r.invoiceId) ?? 0) + r.amountCents);
  return by;
}
