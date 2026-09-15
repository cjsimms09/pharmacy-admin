/**
 * Re-reads the item lines of every invoice the site holds, against the readers as they stand today.
 *
 * A reader that learns a new layout does nothing for the invoices already filed under the old one:
 * they keep whatever was read at the time, which for three of the pharmacy's first twelve was
 * nothing at all. This is the catch-up. It is safe to run at any time — the lines of an invoice are
 * replaced only when the new reading reconciles against the invoice's own figures, so a worse
 * reading cannot overwrite a better one.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/reread-invoice-lines.ts
 */
import "dotenv/config";

async function main() {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { readFile } = await import("../src/lib/files");
  const { pdfText } = await import("../src/lib/pdf-text");
  const { storeInvoiceLines, readTotalCents } = await import("../src/lib/invoices");

  const invoices = await db.query.supplierInvoices.findMany();
  let read = 0;
  let already = 0;
  let failed = 0;
  for (const inv of invoices) {
    if (!inv.documentId) continue;
    const doc = await db.query.documents.findFirst({ where: (t, { eq: e }) => e(t.id, inv.documentId!) });
    if (!doc) continue;
    let text = "";
    try {
      text = pdfText(await readFile(doc.storageKey));
    } catch {
      continue;
    }
    const printed = inv.totalCents ?? readTotalCents(text);
    const before = (await db.query.invoiceLines.findMany({ where: (t, { eq: e }) => e(t.invoiceId, inv.id) })).length;
    const r = await storeInvoiceLines(inv.id, { supplier: inv.supplier, supplierId: inv.supplierId, invoiceDate: inv.invoiceDate, text, printedTotalCents: printed });
    if (r.stored > 0 && inv.totalCents === null && printed !== null) {
      await db.update(schema.supplierInvoices).set({ totalCents: printed }).where(eq(schema.supplierInvoices.id, inv.id));
    }
    if (r.stored > 0) {
      await db.update(schema.supplierInvoices).set({ linesRead: r.stored, linesUnread: r.unread }).where(eq(schema.supplierInvoices.id, inv.id));
      if (before === 0) read++;
      else already++;
    } else {
      failed++;
      console.log(`still unread: ${inv.supplier} ${inv.invoiceDate} ${doc.fileName} — ${r.unread} lines seen, reconciles ${r.reconciles}, read $${(r.readCents / 100).toFixed(2)} against $${((printed ?? 0) / 100).toFixed(2)}`);
    }
  }
  console.log(`${invoices.length} invoices: ${read} newly read, ${already} re-read, ${failed} still unread.`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
