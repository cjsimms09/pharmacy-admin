# Every field on a claim, and whether it is populated

*Generated 2026-09-16 00:23 by `scripts/registers.ts`. Do not edit — edit `docs/registers/decisions.md` and run it again.*

A claim carries facts a pharmacist acts on. A field the feed never fills is a fact the site cannot use — and one it fills but nothing reads is a fact being thrown away. Counted over the 2,981 paid in-books claims.

| Field | Populated | Empty | State |
|---|---|---|---|
| `id` | 2,981 | 0 | captured |
| `import_id` | 2,981 | 0 | captured |
| `rx_number` | 2,981 | 0 | captured |
| `fill_number` | 2,981 | 0 | captured |
| `date_filled` | 2,981 | 0 | captured |
| `ndc11` | 2,981 | 0 | captured |
| `item_name` | 2,933 | 48 | captured |
| `bin` | 2,981 | 0 | captured |
| `pcn` | 2,861 | 120 | captured |
| `group_number` | 2,383 | 598 | captured |
| `network_id` | 2,398 | 583 | captured |
| `plan_id` | 754 | 2,227 | captured |
| `plan_type` | 0 | 2,981 | **never populated** |
| `pharmacy_service_type` | 0 | 2,981 | **never populated** |
| `basis_of_reimbursement` | 2,814 | 167 | captured |
| `basis_of_cost_determination` | 2,930 | 51 | captured |
| `payer_label` | 2,951 | 30 | captured |
| `pbm_name` | 2,973 | 8 | captured |
| `match_method` | 2,973 | 8 | captured |
| `payer_ambiguous` | 2,981 | 0 | captured |
| `quantity_thousandths` | 2,981 | 0 | captured |
| `quantity_unit` | 0 | 2,981 | **never populated** |
| `days_supply` | 2,976 | 5 | captured |
| `remit_cents` | 2,981 | 0 | captured |
| `copay_cents` | 2,981 | 0 | captured |
| `awp_cents` | 6 | 2,975 | captured |
| `acquisition_cents` | 2,981 | 0 | captured |
| `gross_profit_cents` | 2,951 | 30 | captured |
| `ingredient_paid_cents` | 2,951 | 30 | captured |
| `dispensing_fee_paid_cents` | 2,980 | 1 | captured |
| `daw` | 5 | 2,976 | captured |
| `raw_json` | 2,951 | 30 | captured |
| `created_at` | 2,981 | 0 | captured |
| `status` | 2,981 | 0 | captured |
| `reversed_on` | 0 | 2,981 | **never populated** |
| `transaction_key` | 2,951 | 30 | captured |
| `reversal_key` | 0 | 2,981 | **never populated** |
| `source` | 2,981 | 0 | captured |
| `completed_at` | 1,802 | 1,179 | captured |
| `patient_total_cents` | 2,951 | 30 | captured |
| `expected_facilitator_cents` | 2,951 | 30 | captured |
| `cash_plan` | 2,981 | 0 | captured |
| `on_account` | 2,981 | 0 | captured |
| `wac_cents` | 6 | 2,975 | captured |
| `nadac_dispensed_cents` | 8 | 2,973 | captured |
| `dir_fee_cents` | 5 | 2,976 | captured |
| `evoucher_cents` | 2,960 | 21 | captured |
| `contract_id` | 3 | 2,978 | captured |
| `gcn` | 2,968 | 13 | captured |
| `sold_on` | 2,584 | 397 | captured |
| `enriched_from` | 2,971 | 10 | captured |
| `sold_checked_on` | 0 | 2,981 | **never populated** |
| `evoucher_message_cents` | 0 | 2,981 | **never populated** |
| `evoucher_programme` | 0 | 2,981 | **never populated** |
| `payer_position` | 0 | 2,981 | **never populated** |
| `fill_total_price_cents` | 0 | 2,981 | **never populated** |

**10 fields are never populated:** `plan_type`, `pharmacy_service_type`, `quantity_unit`, `reversed_on`, `reversal_key`, `sold_checked_on`, `evoucher_message_cents`, `evoucher_programme`, `payer_position`, `fill_total_price_cents`
