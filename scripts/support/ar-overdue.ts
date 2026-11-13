import "dotenv/config";
const $ = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const paid = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, julianday(p.received_on) - julianday(c.date_filled) days from claim_payments p join claims c on c.id = p.claim_id where p.source='plan' and c.date_filled >= '2026-09-01'`)) as any[];
  const by = new Map<string, number[]>();
  for (const r of paid) by.set(r.payer, [...(by.get(r.payer) ?? []), r.days]);
  const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]; };
  const unpaid = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, c.remit_cents cents, julianday('2026-10-01') - julianday(c.date_filled) age from claims c where c.date_filled >= '2026-09-01' and c.status = 'paid' and c.remit_cents > 0 and c.cash_plan = 0 and c.id not in (select claim_id from claim_payments where claim_id is not null)`)) as any[];
  const out = new Map<string, { n: number; cents: number; dueN: number; dueCents: number; cycle: number | null; sample: number }>();
  for (const u of unpaid) {
    const xs = by.get(u.payer) ?? [];
    const cycle = xs.length >= 5 ? p90(xs) : null;
    const e = out.get(u.payer) ?? { n: 0, cents: 0, dueN: 0, dueCents: 0, cycle, sample: xs.length };
    e.n++; e.cents += u.cents;
    if (cycle !== null && u.age > cycle) { e.dueN++; e.dueCents += u.cents; }
    out.set(u.payer, e);
  }
  let tn = 0, tc = 0, dn = 0, dc = 0, un = 0, uc = 0;
  for (const [p, e] of [...out].sort((a, b) => b[1].cents - a[1].cents)) {
    tn += e.n; tc += e.cents; dn += e.dueN; dc += e.dueCents; if (e.cycle === null) { un += e.n; uc += e.cents; }
    console.log(`${String(p).slice(0, 28).padEnd(28)} unpaid ${String(e.n).padStart(4)} $${$(e.cents).padStart(11)}  cycle(p90) ${e.cycle === null ? "unknown (" + e.sample + " paid)" : e.cycle + "d"}  past cycle ${String(e.dueN).padStart(4)} $${$(e.dueCents).padStart(10)}`);
  }
  console.log(`TOTAL unpaid ${tn} $${$(tc)}; past the payer's own cycle ${dn} $${$(dc)}; payer cycle unknown ${un} $${$(uc)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
