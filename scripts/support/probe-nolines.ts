/**
 * The invoices with a total and no item lines, with the text the reader actually saw. Read-only.
 */
import "dotenv/config";

async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await c.execute(`
    select i.id, i.supplier, i.invoice_number, i.total_cents, i.lines_read, i.schedule, i.needs_review, d.storage_key k, d.file_name
      from supplier_invoices i join documents d on d.id = i.document_id
     where i.total_cents is not null and (i.lines_read is null or i.lines_read = 0)`);
  console.log(`invoices with a total and no lines: ${r.rows.length}`);
  const { readFile } = await import("../../src/lib/files");
  const { pdfText } = await import("../../src/lib/pdf-text");
  const { parseInvoiceLines } = await import("../../src/lib/invoice-lines");
  for (const row of r.rows) {
    console.log(`\n===== ${row.supplier} ${row.invoice_number} — ${(Number(row.total_cents) / 100).toFixed(2)} — schedule ${row.schedule} — ${row.file_name} =====`);
    let text = "";
    try {
      text = pdfText(await readFile(String(row.k)));
    } catch (e) {
      console.log("  could not read the file:", e instanceof Error ? e.message : e);
      continue;
    }
    console.log(`  characters of text: ${text.trim().length}`);
    const p = parseInvoiceLines(text, Number(row.total_cents));
    console.log(`  reader: format=${p.format} lines=${p.lines.length} charges=${p.charges.length} unrecognised=${p.unrecognised.length} reconciles=${p.reconciles}`);
    for (const ch of p.charges) console.log(`    charge: ${ch.description} ${(ch.amountCents / 100).toFixed(2)}`);
    for (const u of p.unrecognised.slice(0, 6)) console.log(`    unrecognised: ${u}`);
    const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    console.log("  --- the page as text ---");
    for (const l of lines.slice(0, 60)) console.log("  | " + l);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
