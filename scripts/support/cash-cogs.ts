/** Which invoices the cash account counts for a month, and how well each one's date is known. */
import { db, schema } from "../../src/db";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const month = process.argv[2] ?? "2026-09";
  const invoices = await db.select().from(schema.supplierInvoices);
  const suppliers = await db.select().from(schema.suppliers);
  const terms = (v: (typeof invoices)[number]) => {
    const s = suppliers.find((s) => s.id === v.supplierId) ?? suppliers.find((s) => v.supplier && s.name.toLowerCase() === v.supplier.toLowerCase());
    return s?.paymentTermsDays ?? null;
  };
  const cashDate = (v: (typeof invoices)[number]) => {
    if (v.paidOn) return { on: v.paidOn, how: "recorded paid date" };
    if (!v.invoiceDate) return null;
    const d = new Date(`${v.invoiceDate}T00:00:00Z`);
    const t = terms(v) ?? 0;
    d.setUTCDate(d.getUTCDate() + t);
    return { on: d.toISOString().slice(0, 10), how: t ? `invoice date + ${t}d terms` : "invoice date, no terms on file" };
  };
  let counted = 0;
  const byHow = new Map<string, { n: number; cents: number }>();
  console.log(`invoices on file: ${invoices.length}`);
  for (const v of invoices) {
    const cd = cashDate(v);
    if (v.totalCents === null || !cd?.on.startsWith(month)) continue;
    counted += v.totalCents;
    const e = byHow.get(cd.how) ?? { n: 0, cents: 0 };
    byHow.set(cd.how, { n: e.n + 1, cents: e.cents + v.totalCents });
  }
  console.log(`\ncash cost of goods for ${month}: ${money(counted)}`);
  for (const [how, e] of byHow) console.log(`   ${e.n} invoice(s), ${money(e.cents)} — ${how}`);
  const dated = invoices.filter((v) => v.invoiceDate?.startsWith(month) && v.totalCents !== null);
  console.log(`\nfor comparison, invoices DATED ${month}: ${dated.length}, ${money(dated.reduce((n, v) => n + (v.totalCents ?? 0), 0))}`);
  const noTotal = invoices.filter((v) => v.totalCents === null);
  if (noTotal.length) console.log(`\n${noTotal.length} invoice(s) carry no total and cannot be counted on either basis`);
  const withTerms = suppliers.filter((s) => s.paymentTermsDays);
  console.log(`\nsuppliers with payment terms on file: ${withTerms.length} of ${suppliers.length}${withTerms.length ? ` — ${withTerms.map((s) => `${s.name} ${s.paymentTermsDays}d`).join(", ")}` : ""}`);
}
main().then(() => process.exit(0));
