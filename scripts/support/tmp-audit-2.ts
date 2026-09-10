import "dotenv/config";
import { createClient } from "@libsql/client";
import path from "node:path";
const c = createClient({ url: `file:${path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db")}` });
const q = async (l: string, sql: string) => { try { const r = await c.execute(sql); console.log(`\n### ${l}`); for (const row of r.rows) console.log("   " + JSON.stringify(row)); if(!r.rows.length) console.log("   (none)"); } catch(e){ console.log(`\n### ${l}\n   ERR ${(e as Error).message}`);} };
async function main(){
  await q("zero-acquisition claims sold in Sept", `select item_name, ndc11, remit_cents, patient_total_cents, acquisition_cents, gross_profit_cents, status, cash_plan from claims where acquisition_cents = 0 and coalesce(completed_at,sold_on) like '2026-09%' limit 20`);
  await q("zero-acq count by sold month + revenue on them", `select substr(coalesce(completed_at,sold_on),1,7) m, count(*) n, sum(coalesce(remit_cents,0)+coalesce(patient_total_cents,0)) rev, sum(coalesce(gross_profit_cents,0)) reported_gp from claims where acquisition_cents = 0 group by 1`);
  await q("claim_payments null revenue rows", `select source, received_on, amount_cents, revenue_cents, top_off_cents from claim_payments where revenue_cents is null`);
  await q("claim_payments sept mtf total", `select sum(coalesce(revenue_cents, amount_cents)) fallback_total, sum(coalesce(revenue_cents,0)) strict_total, sum(amount_cents) gross from claim_payments where source='mtf' and received_on like '2026-09%'`);
  await q("supplier_invoices no invoice_date", `select count(*) n from supplier_invoices where invoice_date is null`);
  await q("supplier_invoices sept detail", `select count(*) n, sum(total_cents) total, sum(case when invoice_number is null then 1 else 0 end) no_num from supplier_invoices where invoice_date like '2026-09%'`);
  await q("cash_receipts detail", `select month, kind, amount_cents, received_on from cash_receipts order by month, kind limit 30`);
  await q("expenses count", `select count(*) n from expenses`);
  await q("claims patient money sold in sept", `select sum(patient_total_cents) pt, sum(copay_cents) cp from claims where coalesce(completed_at,sold_on) like '2026-09%'`);
  await q("claims completed_at vs sold_on population", `select count(*) n, sum(case when completed_at is null then 1 else 0 end) ca_null, sum(case when sold_on is null then 1 else 0 end) so_null, sum(case when completed_at is null and sold_on is not null then 1 else 0 end) only_soldon from claims`);
  await q("earliest/latest date_filled", `select min(date_filled), max(date_filled), min(coalesce(completed_at,sold_on)), max(coalesce(completed_at,sold_on)) from claims`);
}
main().then(()=>process.exit(0));
