/**
 * Every invoice on file that does not currently balance, re-read with the tax reader in place.
 *
 * Read-only: it parses, compares and prints. Nothing is stored. The point is to see, before this
 * ships, both halves — which invoices it now explains, and that it claims nothing on the ones it
 * should leave alone.
 */
import "dotenv/config";

async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const { readFile } = await import("../../src/lib/files");
  const { pdfText } = await import("../../src/lib/pdf-text");
  const { parseInvoiceLines } = await import("../../src/lib/invoice-lines");

  const rows = await c.execute(`
    select i.id, i.supplier, i.invoice_number, i.total_cents, d.storage_key as k
      from supplier_invoices i join documents d on d.id = i.document_id
     where i.total_cents is not null order by i.invoice_date desc limit 200`);

  let balanced = 0;
  const explained: string[] = [];
  const stillShort: string[] = [];
  for (const r of rows.rows) {
    let text = "";
    try {
      text = pdfText(await readFile(String(r.k)));
    } catch {
      continue;
    }
    const total = Number(r.total_cents);
    const p = parseInvoiceLines(text, total);
    if (p.lines.length === 0) continue;
    const gap = total - p.totalCents - p.chargesCents;
    const tax = p.charges.find((ch) => ch.description === "Sales tax");
    if (gap === 0 && tax) explained.push(`${r.supplier} ${r.invoice_number}: tax ${(tax.amountCents / 100).toFixed(2)}, now balances at ${(total / 100).toFixed(2)}`);
    else if (gap === 0) balanced++;
    else stillShort.push(`${r.supplier} ${r.invoice_number}: off by ${(gap / 100).toFixed(2)} on ${(total / 100).toFixed(2)}, ${p.lines.length} lines${tax ? " (tax claimed!)" : ""}`);
  }

  console.log(`balanced without needing tax: ${balanced}`);
  console.log(`explained by tax: ${explained.length}`);
  for (const l of explained) console.log("  " + l);
  console.log(`still not balancing: ${stillShort.length}`);
  for (const l of stillShort) console.log("  " + l);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
