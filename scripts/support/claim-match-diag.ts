import "dotenv/config";
const $ = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const byMonth = (await db.all(sql`select substr(date_filled,1,7) m, count(*) n, sum(remit_cents) remit from claims group by m order by m`)) as any[];
  console.log("CLAIMS by fill month:", byMonth.map((r) => `${r.m}: ${r.n} ($${$(r.remit ?? 0)} expected remit)`).join(" | "));
  const un = (await db.all(sql`select p.rx_number rx, p.fill_number fill, p.date_filled df, p.amount_cents c, p.payer from claim_payments p where p.source='plan' and p.claim_id is null and p.received_on >= '2026-09-01' and p.received_on <= '2026-09-30'`)) as any[];
  const total = un.length;
  let rxKnown = 0, rxFillKnown = 0, rxFillDateKnown = 0, dfPre = 0, dfNull = 0;
  const sampleMiss: string[] = [];
  for (const p of un) {
    if (!p.df) dfNull++;
    else if (p.df < "2026-09-01") dfPre++;
    const rows = (await db.all(sql`select rx_number, fill_number, date_filled from claims where rx_number = ${p.rx}`)) as any[];
    if (rows.length) rxKnown++;
    if (rows.some((r) => String(r.fill_number) === String(p.fill))) rxFillKnown++;
    if (rows.some((r) => String(r.fill_number) === String(p.fill) && r.date_filled === p.df)) rxFillDateKnown++;
    else if (rows.length && sampleMiss.length < 4) sampleMiss.push(`pay fill ${p.fill} filled ${p.df} vs claims ${rows.map((r) => `${r.fill_number}@${r.date_filled}`).slice(0, 3).join(",")}`);
  }
  console.log(`UNMATCHED Sept plan payments: ${total}; fill date before 1 Sept: ${dfPre}; no fill date: ${dfNull}; rx known in claims: ${rxKnown}; rx+fill known: ${rxFillKnown}; rx+fill+date known: ${rxFillDateKnown}`);
  console.log("samples where rx known but no link:", sampleMiss.join(" || "));
  const unlinked = (await db.all(sql`select r.id, r.received_on, r.amount_cents, r.kind, r.payer, substr(r.source_key,1,14) sk from cash_receipts r where r.received_on >= '2026-09-01' and r.received_on <= '2026-09-30' and r.id not in (select receipt_id from bank_lines where receipt_id is not null) and r.id not in (select receipt_id from bank_line_receipts) order by r.amount_cents desc`)) as any[];
  console.log(`RECEIPTS in Sept with no bank line: ${unlinked.length}, $${$(unlinked.reduce((n: number, r: any) => n + r.amount_cents, 0))}`);
  for (const r of unlinked.slice(0, 14)) console.log(`   ${r.received_on} ${$(r.amount_cents).padStart(10)} ${r.kind.padEnd(11)} ${String(r.payer).slice(0, 26).padEnd(26)} ${r.sk}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
