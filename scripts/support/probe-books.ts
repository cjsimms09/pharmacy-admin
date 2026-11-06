/**
 * September accrual by category, and the invoice issues as worded. Read-only verification.
 */
import "dotenv/config";

async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const q = async (l: string, s: string) => {
    try {
      const r = await c.execute(s);
      console.log(`\n== ${l} ==`);
      for (const x of r.rows) console.log("  " + JSON.stringify(x));
      if (!r.rows.length) console.log("  (none)");
    } catch (e) {
      console.log(`\n== ${l} == ${e instanceof Error ? e.message : e}`);
    }
  };
  await q(
    "September accrual by category",
    `select coalesce(k.name,'(no category)') cat, count(*) n, sum(e.amount_cents) cents
       from expenses e left join expense_categories k on k.id = e.category_id
      where e.invoice_date >= '2026-09-01' and e.invoice_date <= '2026-09-30' group by cat order by cents desc`,
  );
  await q("the supplies bill", `select invoice_number, invoice_date, amount_cents, tax_cents, description, status from expenses where invoice_number like 'RXS-%'`);
  await q("is PSAO fees still a category?", `select name, built_in from expense_categories where name in ('PSAO fees','PBM fees')`);

  const { invoiceIssues } = await import("../../src/lib/invoices");
  console.log("\n== invoice issues, as worded ==");
  const issues = await invoiceIssues();
  for (const i of issues) console.log(`  [${i.severity}] ${i.title}`);
  if (!issues.length) console.log("  (none)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
