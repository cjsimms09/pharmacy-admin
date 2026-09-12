import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const q = async (s: string) => (await db.$client.execute(s)).rows as any[];
  const m = (c: any) => "$" + (Number(c ?? 0) / 100).toFixed(2);
  console.log("== what the patient actually paid at the counter in September (the card-fee base)");
  for (const r of await q(`SELECT sum(coalesce(copay_cents,0)) copays, count(*) n
      FROM claims c JOIN claim_imports i ON i.id=c.import_id AND i.out_of_books=0
     WHERE c.status='paid' AND c.date_filled>='2026-09-01' AND coalesce(c.sold_on,c.completed_at) IS NOT NULL`))
    console.log(`   copays collected on ${r.n} collected fills: ${m(r.copays)}`);
  for (const r of await q(`SELECT month, retail_cents, period_from, period_to FROM sales_months WHERE month='2026-09'`))
    console.log(`   front of shop ${r.period_from}..${r.period_to}: ${m(r.retail_cents)}`);
  console.log("\n== is PioneerRx itself a cost anywhere? and the other certain monthlies");
  for (const term of ["pioneer", "rxsystem", "insur", "utilit", "phone", "internet", "payroll tax", "dea", "licen", "bank", "card", "merchant", "waste", "fuel"]) {
    const r = await q(`SELECT count(*) n FROM standing_costs WHERE lower(name) LIKE '%${term}%'
       UNION ALL SELECT count(*) FROM vendors WHERE lower(name) LIKE '%${term}%'`);
    const s = Number(r[0].n), v = Number(r[1].n);
    if (s === 0) console.log(`   ${term.padEnd(12)} standing cost: none      vendor on file: ${v}`);
  }
  console.log("\n== vendors on file at all");
  for (const r of await q(`SELECT name FROM vendors ORDER BY name LIMIT 20`)) console.log(`   ${r.name}`);
}
main().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
