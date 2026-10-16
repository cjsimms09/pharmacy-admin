import "dotenv/config";
const $ = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const pa = (await db.all(sql`select placed_as p, count(*) n, sum(case when amount_cents>0 then amount_cents else 0 end) inn, sum(case when amount_cents<0 then amount_cents else 0 end) outt from bank_lines where "on" >= '2026-09-01' and "on" <= '2026-09-30' group by placed_as order by n desc`)) as any[];
  console.log("BANK by placement:", pa.map((r) => `${r.p} ${r.n} (+${$(r.inn)} / ${$(r.outt)})`).join(" | "));
  const bank = (await db.all(sql`select sum(case when amount_cents>0 then amount_cents else 0 end) inn, sum(case when amount_cents<0 then -amount_cents else 0 end) outt, count(*) n from bank_lines where "on" >= '2026-09-01' and "on" <= '2026-09-30'`)) as any[];
  const rc = (await db.all(sql`select kind, count(*) n, sum(amount_cents) c from cash_receipts where received_on >= '2026-09-01' and received_on <= '2026-09-30' group by kind`)) as any[];
  console.log(`BANK Sept: in ${$(bank[0].inn)} out ${$(bank[0].outt)} (${bank[0].n} lines)`);
  console.log("RECEIPTS Sept by kind:", rc.map((r) => `${r.kind} ${r.n} ${$(r.c)}`).join(" | "), "total", $(rc.reduce((n: number, r: any) => n + r.c, 0)));
  const cp = (await db.all(sql`select payer, count(*) n, sum(amount_cents) c, sum(case when claim_id is not null then 1 else 0 end) matched, sum(case when claim_id is not null then amount_cents else 0 end) mc, sum(case when out_of_books=1 then 1 else 0 end) oob, sum(case when out_of_books=1 then amount_cents else 0 end) oobc from claim_payments where received_on >= '2026-09-01' and received_on <= '2026-09-30' and source='plan' group by payer`)) as any[];
  for (const r of cp) console.log(`835→CLAIM ${String(r.payer).padEnd(24)} payments ${r.n} ${$(r.c)}; matched to a claim ${r.matched} ${$(r.mc)}; before the books ${r.oob} ${$(r.oobc)}; neither ${r.n - r.matched - r.oob} ${$(r.c - r.mc - r.oobc)}`);
  const cols = (await db.all(sql`pragma table_info(claims)`)) as any[];
  console.log("claims cols:", cols.map((c) => c.name).filter((n: string) => /paid|expected|status|adjud|date|pickup|sold|cents/i.test(n)).join(","));
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
