# Every field on a claim, and whether it is populated

*Generated 2026-09-12 18:48 by `scripts/registers.ts`. Do not edit — edit `docs/registers/decisions.md` and run it again.*

A claim carries facts a pharmacist acts on. A field the feed never fills is a fact the site cannot use — and one it fills but nothing reads is a fact being thrown away. Counted over the 2,546 paid in-books claims.

| Field | Populated | Empty | State |
|---|---|---|---|
| `id` | 2,546 | 0 | captured |
| `import_id` | 2,546 | 0 | captured |
| `rx_number` | 2,546 | 0 | captured |
| `fill_number` | 2,546 | 0 | captured |
| `date_filled` | 2,546 | 0 | captured |
| `ndc11` | 2,546 | 0 | captured |
| `item_name` | 2,499 | 47 | captured |
| `bin` | 2,546 | 0 | captured |
| `pcn` | 2,440 | 106 | captured |
| `group_number` | 2,032 | 514 | captured |
| `network_id` | 2,042 | 504 | captured |
| `plan_id` | 595 | 1,951 | captured |
| `plan_type` | 0 | 2,546 | **never populated** |
| `pharmacy_service_type` | 0 | 2,546 | **never populated** |
| `basis_of_reimbursement` | 2,206 | 340 | captured |
| `basis_of_cost_determination` | 2,300 | 246 | captured |
| `payer_label` | 2,516 | 30 | captured |
| `pbm_name` | 2,538 | 8 | captured |
| `match_method` | 2,538 | 8 | captured |
| `payer_ambiguous` | 2,546 | 0 | captured |
| `quantity_thousandths` | 2,546 | 0 | captured |
| `quantity_unit` | 0 | 2,546 | **never populated** |
| `days_supply` | 2,541 | 5 | captured |
| `remit_cents` | 2,546 | 0 | captured |
| `copay_cents` | 2,546 | 0 | captured |
| `awp_cents` | 6 | 2,540 | captured |
| `acquisition_cents` | 2,546 | 0 | captured |
| `gross_profit_cents` | 2,516 | 30 | captured |
| `ingredient_paid_cents` | 2,516 | 30 | captured |
| `dispensing_fee_paid_cents` | 2,545 | 1 | captured |
| `daw` | 5 | 2,541 | captured |
| `raw_json` | 2,516 | 30 | captured |
| `created_at` | 2,546 | 0 | captured |
| `status` | 2,546 | 0 | captured |
| `reversed_on` | 0 | 2,546 | **never populated** |
| `transaction_key` | 2,516 | 30 | captured |
| `reversal_key` | 0 | 2,546 | **never populated** |
| `source` | 2,546 | 0 | captured |
| `completed_at` | 1,606 | 940 | captured |
| `patient_total_cents` | 2,516 | 30 | captured |
| `expected_facilitator_cents` | 2,516 | 30 | captured |
| `cash_plan` | 2,546 | 0 | captured |
| `on_account` | 2,546 | 0 | captured |
| `wac_cents` | 6 | 2,540 | captured |
| `nadac_dispensed_cents` | 8 | 2,538 | captured |
| `dir_fee_cents` | 5 | 2,541 | captured |
| `evoucher_cents` | 2,314 | 232 | captured |
| `contract_id` | 3 | 2,543 | captured |
| `gcn` | 2,319 | 227 | captured |
| `sold_on` | 1,873 | 673 | captured |
| `enriched_from` | 2,322 | 224 | captured |
| `sold_checked_on` | 0 | 2,546 | **never populated** |

**6 fields are never populated:** `plan_type`, `pharmacy_service_type`, `quantity_unit`, `reversed_on`, `reversal_key`, `sold_checked_on`
