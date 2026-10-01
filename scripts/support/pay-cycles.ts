import "dotenv/config";
const $ = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const rows = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, julianday(p.received_on) - julianday(c.date_filled) days from claim_payments p join claims c on c.id = p.claim_id where p.source='plan' and c.date_filled >= '2026-09-01' and p.received_on <= '2026-09-30'`)) as any[];
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.payer, [...(by.get(r.payer) ?? []), r.days]);
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  console.log("DAYS FROM FILL TO PAYMENT (Sept, matched):");
  for (const [p, xs] of [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) console.log(`   ${String(p).slice(0, 26).padEnd(26)} n=${String(xs.length).padStart(4)}  p50=${pct(xs, 0.5)}d  p90=${pct(xs, 0.9)}d  max=${Math.max(...xs)}d`);
  const unpaid = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, count(*) n, sum(c.remit_cents) remit, min(c.date_filled) oldest from claims c where c.date_filled >= '2026-09-01' and c.status = 'paid' and c.remit_cents > 0 and c.cash_plan = 0 and c.id not in (select claim_id from claim_payments where claim_id is not null) group by payer order by remit desc limit 12`)) as any[];
  console.log("UNPAID Sept claims by payer:");
  for (const r of unpaid) console.log(`   ${String(r.payer).slice(0, 26).padEnd(26)} ${String(r.n).padStart(4)} $${$(r.remit).padStart(12)} oldest fill ${r.oldest}`);
  const home = (await db.all(sql`select count(*) n from claims where cash_plan = 1 and date_filled >= '2026-09-01'`)) as any[];
  console.log("cash-plan claims Sept:", home[0].n);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
