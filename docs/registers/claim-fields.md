# Every field on a claim, and whether it is populated

*Generated 2026-09-17 18:01 by `scripts/registers.ts`. Do not edit — edit `docs/registers/decisions.md` and run it again.*

A claim carries facts a pharmacist acts on. A field the feed never fills is a fact the site cannot use — and one it fills but nothing reads is a fact being thrown away. Counted over the 3,607 paid in-books claims.

| Field | Populated | Empty | State |
|---|---|---|---|
| `id` | 3,607 | 0 | captured |
| `import_id` | 3,607 | 0 | captured |
| `rx_number` | 3,607 | 0 | captured |
| `fill_number` | 3,607 | 0 | captured |
| `date_filled` | 3,607 | 0 | captured |
| `ndc11` | 3,606 | 1 | captured |
| `item_name` | 3,560 | 47 | captured |
| `bin` | 3,607 | 0 | captured |
| `pcn` | 3,446 | 161 | captured |
| `group_number` | 2,900 | 707 | captured |
| `network_id` | 2,910 | 697 | captured |
| `plan_id` | 895 | 2,712 | captured |
| `plan_type` | 0 | 3,607 | **never populated** |
| `pharmacy_service_type` | 0 | 3,607 | **never populated** |
| `basis_of_reimbursement` | 3,391 | 216 | captured |
| `basis_of_cost_determination` | 3,540 | 67 | captured |
| `payer_label` | 3,577 | 30 | captured |
| `pbm_name` | 3,596 | 11 | captured |
| `match_method` | 3,599 | 8 | captured |
| `payer_ambiguous` | 3,607 | 0 | captured |
| `quantity_thousandths` | 3,607 | 0 | captured |
| `quantity_unit` | 0 | 3,607 | **never populated** |
| `days_supply` | 3,602 | 5 | captured |
| `remit_cents` | 3,607 | 0 | captured |
| `copay_cents` | 3,607 | 0 | captured |
| `awp_cents` | 6 | 3,601 | captured |
| `acquisition_cents` | 3,607 | 0 | captured |
| `gross_profit_cents` | 3,577 | 30 | captured |
| `ingredient_paid_cents` | 3,577 | 30 | captured |
| `dispensing_fee_paid_cents` | 3,606 | 1 | captured |
| `daw` | 5 | 3,602 | captured |
| `raw_json` | 3,577 | 30 | captured |
| `created_at` | 3,607 | 0 | captured |
| `status` | 3,607 | 0 | captured |
| `reversed_on` | 0 | 3,607 | **never populated** |
| `transaction_key` | 3,577 | 30 | captured |
| `reversal_key` | 0 | 3,607 | **never populated** |
| `source` | 3,607 | 0 | captured |
| `completed_at` | 2,089 | 1,518 | captured |
| `patient_total_cents` | 3,577 | 30 | captured |
| `expected_facilitator_cents` | 3,577 | 30 | captured |
| `cash_plan` | 3,607 | 0 | captured |
| `on_account` | 3,607 | 0 | captured |
| `wac_cents` | 6 | 3,601 | captured |
| `nadac_dispensed_cents` | 8 | 3,599 | captured |
| `dir_fee_cents` | 5 | 3,602 | captured |
| `evoucher_cents` | 3,590 | 17 | captured |
| `contract_id` | 3 | 3,604 | captured |
| `gcn` | 3,593 | 14 | captured |
| `sold_on` | 3,157 | 450 | captured |
| `enriched_from` | 3,599 | 8 | captured |
| `sold_checked_on` | 0 | 3,607 | **never populated** |
| `evoucher_message_cents` | 0 | 3,607 | **never populated** |
| `evoucher_programme` | 51 | 3,556 | captured |
| `payer_position` | 3,590 | 17 | captured |
| `fill_total_price_cents` | 3,498 | 109 | captured |

**7 fields are never populated:** `plan_type`, `pharmacy_service_type`, `quantity_unit`, `reversed_on`, `reversal_key`, `sold_checked_on`, `evoucher_message_cents`
