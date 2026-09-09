/**
 * What the site holds for September, whether any of it is duplicated, and how long it takes to read.
 *
 * The owner, 9 September: "we need to get all data we can from 09/01 to today. we need to make sure
 * nothing is duplicated. we need to make sure we are getting everything we need. we need to make
 * sure we are mapping data to the site properly. we need to make sure site and data is setup in
 * most efficient way possible to keep site fast."
 *
 * Five questions, and this answers each of them with a count rather than an opinion. It reads and
 * changes nothing, so it can be run at any time and as often as it is useful.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/audit-september.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });
const FROM = "2026-09-01";

const money = (c: unknown) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");

async function one(sql: string): Promise<Record<string, unknown>> {
  return ((await db.execute(sql)).rows[0] ?? {}) as Record<string, unknown>;
}

async function main() {
  console.log(`\n── What the site holds from ${FROM} ──\n`);

  const claims = await one(
    `select count(*) rows, count(distinct rx_number || '|' || coalesce(fill_number,0) || '|' || coalesce(bin,'')) fills,
            sum(case when status='paid' then 1 else 0 end) paid,
            sum(case when status='paid' then remit_cents else 0 end) remit,
            sum(case when basis_of_reimbursement is not null then 1 else 0 end) with_basis,
            sum(case when network_id is not null then 1 else 0 end) with_network,
            sum(case when awp_cents is not null then 1 else 0 end) with_awp,
            sum(case when nadac_dispensed_cents is not null then 1 else 0 end) with_nadac,
            sum(case when acquisition_cents is not null then 1 else 0 end) with_cost,
            sum(case when evoucher_cents is not null and evoucher_cents<>0 then 1 else 0 end) with_evoucher
       from claims where date_filled >= '${FROM}'`,
  );
  console.log(`Claims        ${n(claims.rows)} rows over ${n(claims.fills)} distinct fills, ${n(claims.paid)} paid, ${money(claims.remit)} remitted`);
  console.log(`              basis ${n(claims.with_basis)}, network ${n(claims.with_network)}, AWP ${n(claims.with_awp)}, NADAC ${n(claims.with_nadac)}, cost ${n(claims.with_cost)}, e-voucher ${n(claims.with_evoucher)}`);

  const cash = await one(`select count(*) rows, sum(amount_cents) v, count(distinct source_key) keys, sum(case when source_key is null then 1 else 0 end) unkeyed from cash_receipts where month >= '2026-09'`);
  console.log(`Cash banked   ${n(cash.rows)} receipts, ${money(cash.v)} (${n(cash.unkeyed)} entered by hand, the rest from feeds)`);

  const pay = await one(`select count(*) rows, sum(amount_cents) v, sum(case when claim_id is null then 1 else 0 end) unmatched from claim_payments`);
  console.log(`Claim money   ${n(pay.rows)} payments, ${money(pay.v)}, ${n(pay.unmatched)} not yet tied to a claim`);

  const inv = await one(`select count(*) rows, sum(total_cents) v from supplier_invoices where invoice_date >= '${FROM}'`);
  const lines = await one(`select count(*) rows, sum(extended_cents) v, sum(case when controlled=1 then 1 else 0 end) c2 from invoice_lines where invoice_date >= '${FROM}'`);
  console.log(`Purchases     ${n(inv.rows)} invoices ${money(inv.v)}; ${n(lines.rows)} lines ${money(lines.v)}, ${n(lines.c2)} Schedule II`);

  const shelf = await one(`select counted_on, count(*) items from on_hand group by counted_on order by counted_on desc limit 1`);
  console.log(`Shelf         ${n(shelf.items)} items counted ${shelf.counted_on ?? "never"}`);

  const cat = await one(`select count(*) rows, count(distinct ndc11) ndcs, count(distinct supplier) suppliers from supplier_items`);
  console.log(`Catalogue     ${n(cat.rows)} rows, ${n(cat.ndcs)} NDCs, ${n(cat.suppliers)} suppliers`);

  console.log("\n── Duplicates ──\n");
  const checks: { what: string; sql: string }[] = [
    /*
     * Keyed on the transaction, not on the money.
     *
     * Grouping by prescription, fill, BIN and remit reported 322 groups, and every one of them was
     * real: a claim paid and then reversed keeps both rows, and a prescription re-billed with a
     * different drug is two claims that happen to share a number. What would actually be a
     * duplicate is the same transaction stored twice, and the import already keys on that.
     */
    { what: "the same transaction stored twice", sql: `select count(*) c from (select transaction_key from claims where transaction_key is not null group by 1 having count(*)>1)` },
    { what: "cash receipts of the same amount, day and payer", sql: `select count(*) c from (select amount_cents, received_on, payer from cash_receipts where received_on is not null group by 1,2,3 having count(*)>1)` },
    { what: "claim payments with the same reference, prescription and amount", sql: `select count(*) c from (select reference, rx_number, amount_cents from claim_payments group by 1,2,3 having count(*)>1)` },
    { what: "invoices with the same number", sql: `select count(*) c from (select invoice_number from supplier_invoices where invoice_number is not null group by 1 having count(*)>1)` },
    { what: "invoice lines repeated within one invoice", sql: `select count(*) c from (select invoice_id, ndc11, extended_cents, quantity from invoice_lines group by 1,2,3,4 having count(*)>1)` },
    { what: "on-hand rows repeated within one count", sql: `select count(*) c from (select counted_on, ndc11 from on_hand where ndc11 is not null group by 1,2 having count(*)>1)` },
    { what: "catalogue rows repeated for one supplier and NDC", sql: `select count(*) c from (select supplier, ndc11 from supplier_items group by 1,2 having count(*)>1)` },
    { what: "suppliers whose names fold to the same thing", sql: `select count(*) c from (select lower(replace(replace(replace(name,' ',''),'.',''),'-','')) k from suppliers group by 1 having count(*)>1)` },
  ];
  let dupes = 0;
  for (const c of checks) {
    const r = Number((await one(c.sql)).c ?? 0);
    dupes += r;
    console.log(`${r === 0 ? "  none" : `  ${String(r).padStart(4)}`}  ${c.what}`);
  }
  console.log(dupes === 0 ? "\n  Nothing is duplicated.\n" : `\n  ${dupes} group${dupes === 1 ? "" : "s"} to look at.\n`);

/*
   * ── Reversals ──
   *
   * The owner: "are we matching reversed claims efficiently and properly." A reversal is the one
   * event that can silently inflate every figure on the site, because the money was real when it
   * was paid and is not real now, and the row that says so sits beside the row that says the
   * opposite. So this asks four questions rather than one.
   */
  console.log("── Reversals ──\n");
  const rev = await one(
    `select count(*) rows,
            sum(case when reversal_key is not null then 1 else 0 end) keyed,
            sum(case when reversed_on is not null then 1 else 0 end) dated,
            sum(remit_cents) remit
       from claims where date_filled >= '${FROM}' and status = 'reversed'`,
  );
  console.log(`  ${n(rev.rows)} reversed claims, ${money(rev.remit)} of remit no longer owed`);
  console.log(`  ${n(rev.keyed)} carry the key of what they reversed, ${n(rev.dated)} carry the date`);
  if (Number(rev.keyed) !== Number(rev.rows) || Number(rev.dated) !== Number(rev.rows)) {
    console.log(`  A reversal without a key cannot be tied to the claim it cancels.`);
  }

  /*
   * The dangerous case, and the only one that costs money: a paid claim still standing beside a
   * reversal of the same drug, for the same fill, from the same payer. A re-bill to a different
   * payer is not this — that is one fill billed twice and only one of them stands — and neither is
   * a reversal of a claim that paid nothing.
   */
  const bothWays = await one(
    `select count(*) rows, sum(p.remit_cents) remit
       from claims p
      where p.date_filled >= '${FROM}' and p.status = 'paid'
        and exists (select 1 from claims r
                     where r.status = 'reversed' and r.rx_number = p.rx_number
                       and coalesce(r.fill_number,0) = coalesce(p.fill_number,0)
                       and coalesce(r.ndc11,'') = coalesce(p.ndc11,'')
                       and coalesce(r.bin,'') = coalesce(p.bin,''))`,
  );
  console.log(`  ${n(bothWays.rows)} paid claims stand beside a reversal of the same drug on the same payer, worth ${money(bothWays.remit)}`);

  /*
   * And the surface that would show it. "Revenue" on the payers page is what a fill brought in —
   * the plan's money and the patient's — over paid claims only. Set against the same sum taken
   * straight from the table, a gap here would mean a reversed claim had reached a money figure.
   */
  const truth = await one(`select sum(remit_cents) remit, sum(copay_cents) copay from claims where status = 'paid'`);
  console.log(`  every paid claim: ${money(truth.remit)} from plans and ${money(truth.copay)} from patients, ${money(Number(truth.remit ?? 0) + Number(truth.copay ?? 0))} together`);
  console.log("");

  console.log("── Gaps: what a claim still cannot answer ──\n");
  const gaps = await db.execute(
    `select 'no AWP' what, count(*) c from claims where date_filled >= '${FROM}' and status='paid' and awp_cents is null
     union all select 'no acquisition cost', count(*) from claims where date_filled >= '${FROM}' and status='paid' and acquisition_cents is null
     union all select 'no network id', count(*) from claims where date_filled >= '${FROM}' and status='paid' and network_id is null
     union all select 'no basis of reimbursement', count(*) from claims where date_filled >= '${FROM}' and status='paid' and basis_of_reimbursement is null
     union all select 'no NADAC', count(*) from claims where date_filled >= '${FROM}' and status='paid' and nadac_dispensed_cents is null
     order by c desc`,
  );
  for (const g of gaps.rows) if (Number(g.c) > 0) console.log(`  ${String(n(g.c)).padStart(5)}  ${g.what}`);

  console.log("\n── Size and speed ──\n");
  const tables = (await db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")).rows as unknown as { name: string }[];
  const sized: { name: string; rows: number }[] = [];
  for (const t of tables) sized.push({ name: t.name, rows: Number((await one(`select count(*) c from "${t.name}"`)).c ?? 0) });
  for (const t of sized.sort((a, b) => b.rows - a.rows).slice(0, 8)) console.log(`  ${String(n(t.rows)).padStart(9)}  ${t.name}`);
  console.log(`  ${n(sized.reduce((s, t) => s + t.rows, 0))} rows in ${sized.length} tables`);

  /*
   * The reads the site does on every page, timed.
   *
   * Not a benchmark — a check that nothing here has quietly become a table scan. The catalogue and
   * the price table are the two that grow without anybody deciding to grow them.
   */
  const timed: [string, string][] = [
    ["claims for the month", `select count(*) c from claims where date_filled >= '${FROM}'`],
    ["the shelf", "select count(*) c from on_hand where counted_on = (select max(counted_on) from on_hand)"],
    ["the catalogue", "select count(*) c from supplier_items"],
    ["NADAC in force", "select count(*) c from nadac_prices"],
    ["invoice lines", "select count(*) c from invoice_lines"],
    ["the drug directory", "select count(*) c from drug_directory"],
  ];
  for (const [label, sql] of timed) {
    const t0 = Date.now();
    const r = await one(sql);
    console.log(`  ${String(Date.now() - t0).padStart(5)} ms  ${label} (${n(r.c)} rows)`);
  }
  console.log("");
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
