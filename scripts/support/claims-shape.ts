import "dotenv/config";
const $ = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const cols = (await db.all(sql`pragma table_info(claims)`)) as any[];
  console.log("claims columns:", cols.map((c) => c.name).join(","));
  const st = (await db.all(sql`select status, count(*) n, sum(remit_cents) remit from claims where date_filled >= '2026-09-01' group by status`)) as any[];
  console.log("Sept claims by status:", st.map((r) => `${r.status}: ${r.n} ($${$(r.remit ?? 0)})`).join(" | "));
  const payers = (await db.all(sql`select coalesce(pbm_name, payer_label, '?') p, count(*) n, sum(remit_cents) remit from claims where date_filled >= '2026-09-01' and status not in ('reversed') group by p order by remit desc limit 14`)) as any[];
  console.log("Sept claims by payer:", payers.map((r) => `${String(r.p).slice(0, 22)} ${r.n} $${$(r.remit ?? 0)}`).join(" | "));
  const paid = (await db.all(sql`select count(distinct c.id) n, sum(c.remit_cents) remit, sum(coalesce(p.paid,0)) paid from claims c left join (select claim_id, sum(amount_cents) paid from claim_payments where source in ('plan') group by claim_id) p on p.claim_id = c.id where c.date_filled >= '2026-09-01' and c.status not in ('reversed')`)) as any[];
  console.log(`Sept claims: ${paid[0].n}; expected remit $${$(paid[0].remit)}; plan payments tied $${$(paid[0].paid)}; gap $${$(paid[0].remit - paid[0].paid)}`);
  const unpaid = (await db.all(sql`select count(*) n, sum(c.remit_cents) remit from claims c where c.date_filled >= '2026-09-01' and c.status not in ('reversed') and c.remit_cents > 0 and c.id not in (select claim_id from claim_payments where claim_id is not null)`)) as any[];
  console.log(`Sept claims with expected remit and NO payment tied: ${unpaid[0].n}, $${$(unpaid[0].remit)}`);
  const byAge = (await db.all(sql`select case when julianday('2026-10-01') - julianday(c.date_filled) <= 14 then '0-14' when julianday('2026-10-01') - julianday(c.date_filled) <= 30 then '15-30' else '31+' end bucket, count(*) n, sum(c.remit_cents) remit from claims c where c.date_filled >= '2026-09-01' and c.status not in ('reversed') and c.remit_cents > 0 and c.id not in (select claim_id from claim_payments where claim_id is not null) group by bucket`)) as any[];
  console.log("unpaid by age (from fill):", byAge.map((r) => `${r.bucket}: ${r.n} $${$(r.remit)}`).join(" | "));
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
