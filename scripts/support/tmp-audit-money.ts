import "dotenv/config";
import { createClient } from "@libsql/client";
import path from "node:path";

const url = `file:${path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db")}`;
const c = createClient({ url });

const q = async (label: string, sql: string) => {
  try {
    const r = await c.execute(sql);
    console.log(`\n### ${label}`);
    for (const row of r.rows) console.log("   " + JSON.stringify(row));
    if (r.rows.length === 0) console.log("   (no rows)");
  } catch (e) {
    console.log(`\n### ${label}\n   ERROR ${(e as Error).message}`);
  }
};

async function main() {
  await q("sales_months rows", "select month, retail_cents, retail_cost_cents, rx_patient_cents, rx_remit_cents, rx_cents, total_cents from sales_months order by month");

  await q(
    "claims: sold-month vs filled-month crossing (the allFills window bug)",
    `select substr(coalesce(completed_at, sold_on),1,7) as sold_month,
            substr(date_filled,1,7) as filled_month,
            count(*) as fills,
            sum(coalesce(remit_cents,0)+coalesce(patient_total_cents,0)) as revenue_cents,
            sum(coalesce(acquisition_cents,0)) as acq_cents
       from claims
      where coalesce(completed_at, sold_on) is not null
        and substr(coalesce(completed_at, sold_on),1,7) <> substr(date_filled,1,7)
      group by 1,2 order by 1,2`,
  );

  await q(
    "claims: totals by sold month",
    `select substr(coalesce(completed_at, sold_on),1,7) as sold_month, count(*) n,
            sum(coalesce(remit_cents,0)+coalesce(patient_total_cents,0)) rev
       from claims where coalesce(completed_at, sold_on) is not null group by 1 order by 1`,
  );

  await q(
    "claims: waiting (no soldOn) by filled month, with revenue and cost",
    `select substr(date_filled,1,7) m, count(*) n,
            sum(coalesce(remit_cents,0)+coalesce(patient_total_cents,0)) rev,
            sum(coalesce(acquisition_cents,0)) acq,
            sum(case when remit_cents is null then 1 else 0 end) remit_null,
            sum(case when acquisition_cents is null then 1 else 0 end) acq_null
       from claims where coalesce(completed_at, sold_on) is null group by 1 order by 1`,
  );

  await q(
    "supplier_invoices: null totals by month",
    `select substr(invoice_date,1,7) m, count(*) n,
            sum(case when total_cents is null then 1 else 0 end) null_total,
            sum(coalesce(total_cents,0)) known_cents,
            sum(case when paid_on is null then 1 else 0 end) no_paid_on
       from supplier_invoices group by 1 order by 1`,
  );

  await q("on_hand_imports counts", "select counted_on, value_cents, rx_value_cents from on_hand_imports order by counted_on");

  await q("expense_categories", "select id, name, kind from expense_categories order by kind, name");

  await q(
    "expenses by category+month",
    `select substr(e.invoice_date,1,7) m, coalesce(k.name,'(none)') cat, coalesce(k.kind,'?') kind, count(*) n, sum(e.amount_cents) cents
       from expenses e left join expense_categories k on k.id = e.category_id group by 1,2,3 order by 1,2`,
  );

  await q("standing_costs", "select id, name, category_id, vendor_id, amount_cents, from_month, to_month, paid_day from standing_costs");

  await q("cash_receipts", "select month, kind, sum(amount_cents) c, count(*) n from cash_receipts group by 1,2 order by 1,2");

  await q("claim_payments: received_on nullness", "select source, count(*) n, sum(case when received_on is null then 1 else 0 end) no_date, sum(case when revenue_cents is null then 1 else 0 end) no_rev from claim_payments group by 1");

  await q("claims null money columns", "select count(*) n, sum(case when remit_cents is null then 1 else 0 end) remit_null, sum(case when acquisition_cents is null then 1 else 0 end) acq_null, sum(case when patient_total_cents is null then 1 else 0 end) pt_null, sum(case when copay_cents is null then 1 else 0 end) copay_null, sum(case when acquisition_cents = 0 then 1 else 0 end) acq_zero, sum(case when remit_cents = 0 then 1 else 0 end) remit_zero from claims");

  await q("claims: acquisition null by sold month (dropped from COGS)", `select substr(coalesce(completed_at,sold_on),1,7) m, count(*) n, sum(case when acquisition_cents is null then 1 else 0 end) acq_null, sum(coalesce(remit_cents,0)+coalesce(patient_total_cents,0)) rev_all, sum(case when acquisition_cents is null then coalesce(remit_cents,0)+coalesce(patient_total_cents,0) else 0 end) rev_of_null_acq from claims where coalesce(completed_at,sold_on) is not null group by 1 order by 1`);

  await q("invoice_lines by month", "select substr(invoice_date,1,7) m, count(*) n, sum(extended_cents) c from invoice_lines group by 1 order by 1");

  await q("tables", "select name from sqlite_master where type='table' order by name");
}
main().then(() => process.exit(0));
