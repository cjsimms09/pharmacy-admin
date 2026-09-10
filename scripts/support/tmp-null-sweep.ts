import "dotenv/config";
import { createClient } from "@libsql/client";
import path from "node:path";

/** READ-ONLY null/zero sweep. SELECT only; query_only is set on the connection. */
const dbPath = process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db";
const client = createClient({ url: `file:${path.resolve(dbPath)}`, concurrency: 1 });

type Spec = [table: string, col: string, extra?: string];

const SPECS: Spec[] = [
  // ── supplier invoices / lines ──
  ["supplier_invoices", "total_cents"],
  ["supplier_invoices", "lines_read"],
  ["supplier_invoices", "lines_unread"],
  ["supplier_invoices", "invoice_date"],
  ["supplier_invoices", "paid_on"],
  ["supplier_invoices", "received_on"],
  ["supplier_invoices", "supplier_id"],
  ["invoice_lines", "awp_cents"],
  ["invoice_lines", "rebated"],
  ["invoice_lines", "controlled"],
  ["invoice_lines", "supplier_id"],
  ["invoice_lines", "invoice_date"],
  // ── suppliers terms ──
  ["suppliers", "minimum_order_cents"],
  ["suppliers", "free_freight_cents"],
  ["suppliers", "freight_cents"],
  ["suppliers", "lead_time_days"],
  ["suppliers", "payment_terms_days"],
  // ── expenses / standing / vendors ──
  ["expenses", "paid_on"],
  ["expenses", "tax_cents"],
  ["expenses", "category_id"],
  ["expenses", "vendor_id"],
  ["standing_costs", "paid_day"],
  ["standing_costs", "to_month"],
  ["standing_costs", "category_id"],
  ["vendors", "typical_cents"],
  ["vendors", "category_id"],
  // ── cash receipts ──
  ["cash_receipts", "received_on"],
  ["cash_receipts", "remit_matched"],
  ["cash_receipts", "claim_match_cents"],
  ["cash_receipts", "no_claim_match_cents"],
  ["cash_receipts", "adjustments_cents"],
  ["cash_receipts", "source_key"],
  // ── sales months ──
  ["sales_months", "retail_cents"],
  ["sales_months", "retail_tax_cents"],
  ["sales_months", "retail_cost_cents"],
  ["sales_months", "rx_patient_cents"],
  ["sales_months", "rx_remit_cents"],
  ["sales_months", "rx_cents"],
  ["sales_months", "total_cents"],
  // ── claim imports ──
  ["claim_imports", "report_sales_cents"],
  ["claim_imports", "report_acquisition_cents"],
  ["claim_imports", "report_gross_profit_cents"],
  ["claim_imports", "read_gross_profit_cents"],
  // ── claims ──
  ["claims", "remit_cents"],
  ["claims", "copay_cents"],
  ["claims", "patient_total_cents"],
  ["claims", "acquisition_cents"],
  ["claims", "gross_profit_cents"],
  ["claims", "awp_cents"],
  ["claims", "quantity_thousandths"],
  ["claims", "days_supply"],
  ["claims", "expected_facilitator_cents"],
  ["claims", "evoucher_cents"],
  ["claims", "dir_fee_cents"],
  ["claims", "wac_cents"],
  ["claims", "nadac_dispensed_cents"],
  ["claims", "ingredient_paid_cents"],
  ["claims", "dispensing_fee_paid_cents"],
  ["claims", "completed_at"],
  ["claims", "sold_on"],
  ["claims", "pbm_name"],
  ["claims", "fill_number"],
  ["claims", "ndc11"],
  // ── claim payments ──
  ["claim_payments", "revenue_cents"],
  ["claim_payments", "received_on"],
  ["claim_payments", "claim_id"],
  ["claim_payments", "document_id"],
  ["claim_payments", "date_filled"],
  // ── on hand ──
  ["on_hand_imports", "value_cents"],
  ["on_hand_imports", "rx_value_cents"],
  ["on_hand_imports", "reported_count"],
  ["on_hand_imports", "dated_by"],
  ["on_hand", "on_order_thousandths"],
  ["on_hand", "pack_qty"],
  ["on_hand", "order_point_units"],
  ["on_hand", "unit_cost_micros"],
  ["on_hand", "value_cents"],
  ["on_hand", "ndc11"],
  ["on_hand", "inventory_group"],
  // ── supplier catalogue ──
  ["supplier_items", "unit_cost_micros"],
  ["supplier_items", "pack_cost_cents"],
  ["supplier_items", "awp_cents"],
  ["supplier_items", "pack_size"],
  ["supplier_items", "supplier_id"],
  ["supplier_items", "priced_on"],
  ["supplier_item_fixes", "unit_cost_micros"],
  // ── compliance: expiry / completion ──
  ["credentials", "expires_on"],
  ["credentials", "issued_on"],
  ["documents", "expires_on"],
  ["trainings", "expires_on"],
  ["trainings", "minutes"],
  ["business_associates", "expires_on"],
  ["business_associates", "signed_on"],
  ["business_associates", "ended_on"],
  ["obligations", "due_on"],
  ["obligations", "last_completed_on"],
  ["obligations", "confirmed_on"],
  ["obligation_completions", "period_key"],
  ["obligation_completions", "signature_id"],
  ["self_inspections", "completed_on"],
  ["self_inspection_items", "corrected_on"],
  ["cqi_incidents", "reached_patient"],
  ["cqi_incidents", "review_completed_on"],
  ["cqi_incidents", "cap_implemented_on"],
  ["cqi_cap_reviews", "effective"],
  ["cs_discrepancies", "expected_thousandths"],
  ["cs_discrepancies", "counted_thousandths"],
  ["cs_discrepancies", "resolved_on"],
  ["people", "hired_on"],
  ["people", "ends_on"],
  ["people", "email"],
  ["training_assignments", "completed_at"],
  ["training_assignments", "quiz_correct"],
  ["training_assignments", "quiz_total"],
  ["training_assignments", "qa_attested_on"],
  ["training_assignments", "completed_via"],
  ["manual_sections", "reviewed_on"],
  ["manual_sections", "audited_on"],
  ["manual_sections", "managed_by"],
  ["temp_sensors", "last_reading_at"],
  // ── payer / rates / appeals ──
  ["network_rates", "effective_date"],
  ["network_rates", "effective_to"],
  ["network_rates", "status"],
  ["mac_appeal_terms", "appeal_window_days"],
  ["mac_appeal_terms", "response_sla_days"],
  ["appeals", "deadline"],
  ["appeals", "outcome_cents"],
  ["supplier_rebate_programs", "effective_to"],
  ["supplier_return_policies", "effective_to"],
  ["plan_groups", "pcn"],
  ["plan_groups", "proposed_classification"],
  ["recommendation_log", "outcome_cents"],
  ["contract_docs", "effective_year"],
  ["supply_order_lines", "received_quantity"],
  ["supply_items", "per_unit"],
  ["supply_items", "order_multiple"],
  ["nadac_prices", "classification"],
];

const num = (v: unknown) => Number(v ?? 0);

async function tableExists(t: string): Promise<boolean> {
  const r = await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [t] });
  return r.rows.length > 0;
}

async function main() {
  await client.execute("PRAGMA query_only = ON");
  const rows: string[] = [];
  const seenTables = new Map<string, number>();
  for (const [table, col] of SPECS) {
    if (!(await tableExists(table))) {
      rows.push(`${table}.${col}\tTABLE MISSING`);
      continue;
    }
    let total: number;
    if (seenTables.has(table)) total = seenTables.get(table)!;
    else {
      const r = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
      total = num(r.rows[0].n);
      seenTables.set(table, total);
    }
    const q = await client.execute(
      `SELECT
         SUM(CASE WHEN "${col}" IS NULL THEN 1 ELSE 0 END) AS nulls,
         SUM(CASE WHEN "${col}" IS NOT NULL THEN 1 ELSE 0 END) AS nonnull,
         SUM(CASE WHEN "${col}" = 0 THEN 1 ELSE 0 END) AS zeros,
         SUM(CASE WHEN "${col}" = '' THEN 1 ELSE 0 END) AS empties
       FROM "${table}"`,
    );
    const r0 = q.rows[0];
    rows.push(
      `${table}.${col}\ttotal=${total}\tnull=${num(r0.nulls)}\tnonnull=${num(r0.nonnull)}\tzero=${num(r0.zeros)}\tempty=${num(r0.empties)}`,
    );
  }
  console.log(rows.join("\n"));

  console.log("\n===== FOCUSED CHECKS =====");
  const show = async (label: string, sql: string) => {
    const r = await client.execute(sql);
    console.log(`\n--- ${label} ---`);
    for (const row of r.rows) console.log(JSON.stringify(row));
  };

  await show(
    "supplier_invoices: total null vs lines, by month",
    `SELECT substr(invoice_date,1,7) AS m, COUNT(*) AS n,
            SUM(CASE WHEN total_cents IS NULL THEN 1 ELSE 0 END) AS total_null,
            SUM(CASE WHEN total_cents = 0 THEN 1 ELSE 0 END) AS total_zero,
            SUM(CASE WHEN lines_read IS NULL THEN 1 ELSE 0 END) AS lines_null,
            SUM(CASE WHEN lines_read = 0 THEN 1 ELSE 0 END) AS lines_zero,
            SUM(COALESCE(total_cents,0)) AS cents
       FROM supplier_invoices GROUP BY m ORDER BY m`,
  );

  await show(
    "supplier_invoices: invoices with a total but NO invoice_lines rows",
    `SELECT COUNT(*) AS n, SUM(COALESCE(v.total_cents,0)) AS cents,
            SUM(CASE WHEN v.total_cents IS NULL THEN 1 ELSE 0 END) AS of_which_total_null
       FROM supplier_invoices v
      WHERE NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = v.id)`,
  );

  await show(
    "sales_months rows",
    `SELECT month, retail_cents, retail_tax_cents, retail_cost_cents, rx_patient_cents, rx_remit_cents, rx_cents, total_cents FROM sales_months ORDER BY month`,
  );

  await show(
    "claims: remit_cents null vs zero, split by status/cash_plan",
    `SELECT status, cash_plan, COUNT(*) AS n,
            SUM(CASE WHEN remit_cents IS NULL THEN 1 ELSE 0 END) AS remit_null,
            SUM(CASE WHEN remit_cents = 0 THEN 1 ELSE 0 END) AS remit_zero,
            SUM(CASE WHEN acquisition_cents IS NULL THEN 1 ELSE 0 END) AS acq_null,
            SUM(CASE WHEN acquisition_cents = 0 THEN 1 ELSE 0 END) AS acq_zero,
            SUM(CASE WHEN patient_total_cents IS NULL AND copay_cents IS NULL THEN 1 ELSE 0 END) AS both_patient_null
       FROM claims GROUP BY status, cash_plan`,
  );

  await show(
    "claims: rows where remit AND patient are both null (revenue reads as 0)",
    `SELECT COUNT(*) AS n, SUM(CASE WHEN acquisition_cents IS NOT NULL THEN 1 ELSE 0 END) AS with_cost,
            SUM(COALESCE(acquisition_cents,0)) AS cost_cents
       FROM claims
      WHERE status='paid' AND remit_cents IS NULL AND patient_total_cents IS NULL AND copay_cents IS NULL`,
  );

  await show(
    "claim_payments: revenue_cents null (falls back to full amount)",
    `SELECT source, COUNT(*) AS n,
            SUM(CASE WHEN revenue_cents IS NULL THEN 1 ELSE 0 END) AS rev_null,
            SUM(CASE WHEN revenue_cents = 0 THEN 1 ELSE 0 END) AS rev_zero,
            SUM(CASE WHEN received_on IS NULL THEN 1 ELSE 0 END) AS recv_null,
            SUM(amount_cents) AS amount_cents
       FROM claim_payments GROUP BY source`,
  );

  await show(
    "on_hand: on_order null vs zero, by counted_on (latest 5)",
    `SELECT counted_on, COUNT(*) AS n,
            SUM(CASE WHEN on_order_thousandths IS NULL THEN 1 ELSE 0 END) AS oo_null,
            SUM(CASE WHEN on_order_thousandths = 0 THEN 1 ELSE 0 END) AS oo_zero,
            SUM(CASE WHEN on_order_thousandths > 0 THEN 1 ELSE 0 END) AS oo_pos,
            SUM(CASE WHEN pack_qty IS NULL THEN 1 ELSE 0 END) AS pack_null,
            SUM(CASE WHEN value_cents IS NULL THEN 1 ELSE 0 END) AS val_null
       FROM on_hand GROUP BY counted_on ORDER BY counted_on DESC LIMIT 5`,
  );

  await show(
    "suppliers: terms on file",
    `SELECT name, active, primary_supplier, minimum_order_cents, free_freight_cents, freight_cents, lead_time_days, payment_terms_days, no_rebates FROM suppliers ORDER BY name`,
  );

  await show(
    "expenses: paid_on null by status",
    `SELECT status, COUNT(*) AS n, SUM(CASE WHEN paid_on IS NULL THEN 1 ELSE 0 END) AS paid_null,
            SUM(CASE WHEN tax_cents IS NULL THEN 1 ELSE 0 END) AS tax_null,
            SUM(CASE WHEN tax_cents = 0 THEN 1 ELSE 0 END) AS tax_zero,
            SUM(amount_cents) AS cents
       FROM expenses GROUP BY status`,
  );

  await show("standing_costs", `SELECT name, amount_cents, paid_day, from_month, to_month FROM standing_costs ORDER BY name`);

  await show(
    "credentials: expiry state",
    `SELECT type, COUNT(*) AS n,
            SUM(CASE WHEN expires_on IS NULL AND no_expiry = 0 THEN 1 ELSE 0 END) AS blank_and_not_marked,
            SUM(CASE WHEN expires_on IS NOT NULL AND no_expiry = 1 THEN 1 ELSE 0 END) AS dated_but_marked_noexpiry
       FROM credentials GROUP BY type HAVING blank_and_not_marked > 0 OR dated_but_marked_noexpiry > 0`,
  );

  await show(
    "documents: expires_on set AND no_expiry set (false alert risk)",
    `SELECT COUNT(*) AS both, SUM(CASE WHEN expires_on IS NULL AND no_expiry=0 THEN 1 ELSE 0 END) AS neither
       FROM documents WHERE 1=1`,
  );
  await show(
    "documents: conflicting",
    `SELECT COUNT(*) AS n FROM documents WHERE expires_on IS NOT NULL AND no_expiry = 1`,
  );

  await show(
    "trainings: expires_on null",
    `SELECT type, COUNT(*) AS n, SUM(CASE WHEN expires_on IS NULL THEN 1 ELSE 0 END) AS exp_null FROM trainings GROUP BY type`,
  );

  await show(
    "cash_receipts: kinds and nulls",
    `SELECT kind, COUNT(*) AS n, SUM(CASE WHEN received_on IS NULL THEN 1 ELSE 0 END) AS recv_null,
            SUM(CASE WHEN source_key IS NULL THEN 1 ELSE 0 END) AS key_null, SUM(amount_cents) AS cents
       FROM cash_receipts GROUP BY kind`,
  );

  await show(
    "invoice_lines: rebated / controlled tri-state",
    `SELECT supplier, COUNT(*) AS n,
            SUM(CASE WHEN rebated IS NULL THEN 1 ELSE 0 END) AS reb_null,
            SUM(CASE WHEN rebated = 1 THEN 1 ELSE 0 END) AS reb_true,
            SUM(CASE WHEN rebated = 0 THEN 1 ELSE 0 END) AS reb_false,
            SUM(CASE WHEN supplier_id IS NULL THEN 1 ELSE 0 END) AS supid_null,
            SUM(extended_cents) AS cents
       FROM invoice_lines GROUP BY supplier ORDER BY cents DESC LIMIT 15`,
  );

  await show(
    "on_hand_imports value coverage",
    `SELECT counted_on, rows_read, items_kept, reported_count, value_cents, rx_value_cents, dated_by FROM on_hand_imports ORDER BY counted_on DESC LIMIT 12`,
  );

  await show(
    "obligations: due_on / confirmed_on",
    `SELECT active, needs_confirmation, COUNT(*) AS n,
            SUM(CASE WHEN due_on IS NULL THEN 1 ELSE 0 END) AS due_null,
            SUM(CASE WHEN last_completed_on IS NULL THEN 1 ELSE 0 END) AS last_null,
            SUM(CASE WHEN confirmed_on IS NULL THEN 1 ELSE 0 END) AS conf_null
       FROM obligations GROUP BY active, needs_confirmation`,
  );

  await show(
    "training_assignments: completed with no quiz",
    `SELECT completed_via, COUNT(*) AS n,
            SUM(CASE WHEN quiz_total IS NULL THEN 1 ELSE 0 END) AS quiz_total_null,
            SUM(CASE WHEN quiz_correct IS NULL THEN 1 ELSE 0 END) AS quiz_correct_null,
            SUM(CASE WHEN qa_attested_on IS NULL THEN 1 ELSE 0 END) AS qa_null
       FROM training_assignments WHERE completed_at IS NOT NULL GROUP BY completed_via`,
  );

  await show(
    "supplier_items: cost coverage by supplier",
    `SELECT supplier, COUNT(*) AS n,
            SUM(CASE WHEN unit_cost_micros IS NULL THEN 1 ELSE 0 END) AS ucm_null,
            SUM(CASE WHEN unit_cost_micros = 0 THEN 1 ELSE 0 END) AS ucm_zero,
            SUM(CASE WHEN pack_cost_cents IS NULL THEN 1 ELSE 0 END) AS pcc_null,
            SUM(CASE WHEN awp_cents IS NULL THEN 1 ELSE 0 END) AS awp_null
       FROM supplier_items GROUP BY supplier ORDER BY n DESC LIMIT 15`,
  );

  await show(
    "network_rates: effective_to / status",
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN effective_date IS NULL THEN 1 ELSE 0 END) AS eff_null,
            SUM(CASE WHEN effective_to IS NULL THEN 1 ELSE 0 END) AS to_null,
            SUM(CASE WHEN status IS NULL THEN 1 ELSE 0 END) AS status_null
       FROM network_rates`,
  );

  await show(
    "mac_appeal_terms: window days",
    `SELECT pbm_name, appeal_window_days, response_sla_days FROM mac_appeal_terms ORDER BY pbm_name LIMIT 40`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
