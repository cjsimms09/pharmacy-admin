import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await c.execute(`select name, effective_from, effective_to, json_extract(terms_json,'$.eligibility') basket, coalesce(json_extract(terms_json,'$.ratioMeasure'),'-') measure from supplier_rebate_programs order by basket, measure, effective_from`);
  console.log("== ladders ==");
  for (const x of r.rows) console.log(`  ${x.effective_to ? "ENDED " + String(x.effective_to) : "CURRENT     "}  ${String(x.basket)}/${String(x.measure)}  ${String(x.name)} from ${x.effective_from}`);
  const { dailyCheck } = await import("../../src/lib/daily-check-store");
  const d = await dailyCheck();
  console.log("\n" + d.says);
  for (const x of d.checks) if (!x.ok) console.log(`  FAIL  ${x.what}: ${x.observed}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
