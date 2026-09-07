"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import { parseCsv } from "@/lib/reference";
import { parseBankStatement, placeLines, type MatchContext } from "@/lib/bank-statement";
import { addCashReceipt, unpaid, vendors } from "@/lib/expenses";
import { allSuppliers } from "@/lib/suppliers-registry";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the matcher needs to know about the business, read once per statement. */
async function matchContext(): Promise<MatchContext> {
  const [claims, sup, ven, bills, invoices, receipts] = await Promise.all([
    db.query.claims.findMany({ columns: { pbmName: true, payerLabel: true } }),
    allSuppliers(true),
    vendors(),
    unpaid(),
    db.query.supplierInvoices.findMany({ columns: { id: true, supplierId: true, supplier: true, totalCents: true, invoiceDate: true, paidOn: true } }),
    db.query.cashReceipts.findMany({ columns: { payer: true } }),
  ]);
  const payers = new Set<string>();
  for (const c of claims) for (const n of [c.pbmName, c.payerLabel]) if (n && n.trim().length >= 4) payers.add(n.trim());
  for (const r of receipts) if (r.payer && r.payer.trim().length >= 4) payers.add(r.payer.trim());
  const vendorName = new Map(ven.map((v) => [v.id, v.name]));
  return {
    payers: [...payers],
    suppliers: sup.map((s) => ({ id: s.id, name: s.name })),
    vendors: ven.map((v) => ({ id: v.id, name: v.name })),
    unpaidBills: bills.map((b) => ({ id: b.id, vendorId: b.vendorId, vendorName: b.vendorId ? vendorName.get(b.vendorId) ?? null : null, amountCents: b.amountCents, invoiceDate: b.invoiceDate })),
    unpaidInvoices: invoices.filter((v) => !v.paidOn).map((v) => ({ id: v.id, supplierId: v.supplierId, supplier: v.supplier, totalCents: v.totalCents, invoiceDate: v.invoiceDate })),
  };
}

export async function readBankStatement(fd: FormData) {
  const user = await requireManager();
  const back = `/money?period=${encodeURIComponent(String(fd.get("period") ?? ""))}`;
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) redirect(`${back}&error=${encodeURIComponent("Choose the bank's export.")}`);
  const text = Buffer.from(await file.arrayBuffer()).toString("utf8");
  const parsed = parseBankStatement(parseCsv(text));
  if (parsed.lines.length === 0) redirect(`${back}&error=${encodeURIComponent(parsed.skipped[0]?.why ?? "Nothing in the file could be read as a bank line.")}`);

  /* The file itself is kept, as the record the receipts and paid dates point back to. */
  let documentId: string | null = null;
  try {
    const stored = await storeFile(file, { allowReportTypes: true });
    documentId = newId();
    await db.insert(schema.documents).values({
      id: documentId,
      category: "bank_statement",
      title: `Bank statement ${parsed.lines[0].on} to ${parsed.lines[parsed.lines.length - 1].on}`,
      fileName: file.name.slice(0, 200),
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      uploadedBy: user.id,
    });
  } catch {
    documentId = null;
  }

  const held = new Set((await db.query.bankLines.findMany({ where: inArray(schema.bankLines.key, parsed.lines.map((l) => l.key)), columns: { key: true } })).map((r) => r.key));
  const fresh = parsed.lines.filter((l) => !held.has(l.key));
  const placed = placeLines(fresh, await matchContext());

  let deposits = 0;
  let depositCents = 0;
  let bills = 0;
  let invoices = 0;
  let unplaced = 0;
  for (const { line, placement } of placed) {
    let receiptId: string | null = null;
    let expenseId: string | null = null;
    let invoiceId: string | null = null;
    if (placement.kind === "deposit") {
      receiptId = await addCashReceipt({ month: line.on.slice(0, 7), kind: placement.receiptKind, amountCents: line.amountCents, payer: placement.payer, notes: `From the bank statement: ${line.description}`, createdBy: user.id });
      deposits++;
      depositCents += line.amountCents;
    } else if (placement.kind === "pays_bill") {
      await db.update(schema.expenses).set({ paidOn: line.on }).where(eq(schema.expenses.id, placement.expenseId));
      expenseId = placement.expenseId;
      bills++;
    } else if (placement.kind === "pays_invoice") {
      await db.update(schema.supplierInvoices).set({ paidOn: line.on }).where(eq(schema.supplierInvoices.id, placement.invoiceId));
      invoiceId = placement.invoiceId;
      invoices++;
    } else unplaced++;
    await db.insert(schema.bankLines).values({
      id: newId(),
      key: line.key,
      on: line.on,
      description: line.description,
      amountCents: line.amountCents,
      placedAs: placement.kind,
      why: placement.why,
      receiptId,
      expenseId,
      invoiceId,
      documentId,
      createdBy: user.id,
    });
  }
  await audit({
    action: "bank.statement_read",
    userId: user.id,
    userName: user.name,
    entity: "document",
    entityId: documentId ?? undefined,
    details: `${file.name}: ${parsed.lines.length} lines, ${held.size} already held, ${deposits} deposits ${money(depositCents)}, ${bills} bills and ${invoices} invoices marked paid, ${unplaced} not placed`,
  });
  for (const p of ["/money", "/money/monthly", "/expenses", "/inventory/invoices"]) revalidatePath(p);
  const said =
    `${parsed.lines.length} lines read` +
    (held.size ? `, ${held.size} already held` : "") +
    `: ${deposits} deposit${deposits === 1 ? "" : "s"} banked (${money(depositCents)}), ${bills} bill${bills === 1 ? "" : "s"} and ${invoices} invoice${invoices === 1 ? "" : "s"} marked paid` +
    (unplaced ? `, ${unplaced} not placed — listed below the receipts` : "") +
    (parsed.skipped.length ? `; ${parsed.skipped.length} row${parsed.skipped.length === 1 ? "" : "s"} could not be read` : "") +
    ".";
  redirect(`${back}&ok=${encodeURIComponent(said)}`);
}

/** The statement lines that fall in the period: how many were placed, and the ones that were not. */
export async function lastStatementLines(months: string[]): Promise<{ placed: number; unplaced: { id: string; on: string; description: string; amountCents: number; why: string | null }[] }> {
  const rows = await db.query.bankLines.findMany({ orderBy: (b, { desc }) => [desc(b.on)] });
  const set = new Set(months);
  const mine = rows.filter((r) => set.has(r.on.slice(0, 7)));
  return {
    placed: mine.filter((r) => r.placedAs !== "unplaced").length,
    unplaced: mine.filter((r) => r.placedAs === "unplaced").map((r) => ({ id: r.id, on: r.on, description: r.description, amountCents: r.amountCents, why: r.why })),
  };
}
