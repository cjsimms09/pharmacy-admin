import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await c.execute(`select invoice_number, invoice_date, paid_on, amount_cents from expenses where invoice_number like 'REBATE|%'`);
  console.log("== rebate expenses ==");
  for (const x of r.rows) console.log("  " + JSON.stringify(x));
  const { dailyCheck } = await import("../../src/lib/daily-check-store");
  const d = await dailyCheck();
  console.log("\n" + d.says);
  for (const x of d.checks) console.log(`  ${x.ok ? "PASS" : "FAIL"}  ${x.what}: ${x.observed}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
