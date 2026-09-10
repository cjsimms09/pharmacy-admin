import "dotenv/config";
import { db, schema } from "../../src/db";
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (v: string | null) => (v ?? "").trim().toUpperCase().replace(/^0+/, "");
async function main() {
  const inv = await db.select().from(schema.supplierInvoices);
  const pp = await db.select().from(schema.pioneerPurchases);
  const invByNum = new Map(inv.map((i) => [norm(i.invoiceNumber), i]));
  let matched = 0, matchedCents = 0, unmatched = 0, unmatchedCents = 0, differ = 0;
  for (const p of pp) {
    const m = invByNum.get(norm(p.invoiceNumber));
    if (m) {
      matched++; matchedCents += p.totalCents ?? 0;
      if (m.totalCents !== p.totalCents) { differ++; console.log(`   DIFFER ${p.invoiceNumber} ${p.supplier}: invoice ${money(m.totalCents ?? 0)} vs PioneerRx ${money(p.totalCents ?? 0)}`); }
    } else { unmatched++; unmatchedCents += p.totalCents ?? 0; }
  }
  console.log(`\nPioneerRx purchases: ${pp.length}, ${money(pp.reduce((n, p) => n + (p.totalCents ?? 0), 0))}`);
  console.log(`   matched to an invoice we hold: ${matched}, ${money(matchedCents)}${differ ? ` (${differ} disagree on the figure)` : ""}`);
  console.log(`   no invoice on file:            ${unmatched}, ${money(unmatchedCents)}`);
  console.log(`\ninvoices on file: ${inv.length}, ${money(inv.reduce((n, i) => n + (i.totalCents ?? 0), 0))}`);
  const noNum = inv.filter((i) => !norm(i.invoiceNumber));
  if (noNum.length) console.log(`   of which ${noNum.length} carry no invoice number, so nothing can match them: ${noNum.map((i) => `${i.supplier} ${money(i.totalCents ?? 0)}`).join("; ")}`);
  const ppByNum = new Set(pp.map((p) => norm(p.invoiceNumber)));
  const invOnly = inv.filter((i) => norm(i.invoiceNumber) && !ppByNum.has(norm(i.invoiceNumber)));
  console.log(`   invoices PioneerRx has no record of: ${invOnly.length}, ${money(invOnly.reduce((n, i) => n + (i.totalCents ?? 0), 0))}`);
  for (const i of invOnly.slice(0, 8)) console.log(`      ${i.supplier} ${i.invoiceNumber} ${i.invoiceDate} ${money(i.totalCents ?? 0)}`);
}
main().then(() => process.exit(0));
