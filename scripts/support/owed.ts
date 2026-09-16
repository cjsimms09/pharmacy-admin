import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const q = async (s: string) => (await db.$client.execute(s)).rows as any[];
  const m = (c: any) => "$" + (Number(c ?? 0) / 100).toFixed(2);
  console.log("== every claim expecting money, and whether any arrived");
  for (const r of await q(`
    SELECT count(*) claims,
           sum(c.remit_cents) expected,
           sum(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) no_payment,
           sum(CASE WHEN p.id IS NULL THEN c.remit_cents ELSE 0 END) unpaid_cents,
           sum(CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END) with_payment
      FROM claims c
      JOIN claim_imports i ON i.id=c.import_id AND i.out_of_books=0
      LEFT JOIN claim_payments p ON p.claim_id=c.id AND p.out_of_books=0
     WHERE c.status='paid' AND c.remit_cents > 0`))
    console.log(`   ${r.claims} claims expecting ${m(r.expected)}\n   with a payment attached: ${r.with_payment}\n   with NO payment at all:  ${r.no_payment}  (${m(r.unpaid_cents)})`);

  console.log("\n== the expectation, by payer, so it can be chased");
  for (const r of await q(`
    SELECT coalesce(c.pbm_name,'(unnamed)') payer, count(*) n, sum(c.remit_cents) expected,
           sum(CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END) paid
      FROM claims c
      JOIN claim_imports i ON i.id=c.import_id AND i.out_of_books=0
      LEFT JOIN claim_payments p ON p.claim_id=c.id AND p.out_of_books=0
     WHERE c.status='paid' AND c.remit_cents > 0
     GROUP BY 1 ORDER BY expected DESC LIMIT 12`))
    console.log(`   ${String(r.payer).slice(0,34).padEnd(34)} ${String(r.n).padStart(4)} claims  expecting ${m(r.expected).padStart(12)}  paid on ${r.paid}`);

  console.log("\n== and the reverse: money received that reaches no claim");
  for (const r of await q(`SELECT source, count(*) n, sum(amount_cents) c FROM claim_payments
     WHERE claim_id IS NULL AND out_of_books=0 GROUP BY source`))
    console.log(`   ${String(r.source).padEnd(10)} ${r.n} payments, ${m(r.c)} attached to nothing`);
}
main().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
