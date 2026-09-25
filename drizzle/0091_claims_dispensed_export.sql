-- What PioneerRx's dispensed export says about a claim that the transaction report never did.
--
-- The owner sent "daily_0901_to_0907.xlsx" on 8 September: one row per prescription sold, with the
-- AWP, WAC and NADAC for the dispensed quantity, the DAW, the days supply, the dispensing fee, the
-- basis of reimbursement, the PBM's own contract id, the DIR fee and the e-voucher — "this is the
-- correct info". Each is its own column, in the export's own unit, so that a figure the report
-- printed is never confused with one the site worked out (awp_cents from the catalogue is a
-- different fact and stays where it is; awp_cents here is filled only where the export printed it).
ALTER TABLE `claims` ADD COLUMN `wac_cents` integer;
--> statement-breakpoint
-- NADAC for the dispensed quantity, as PioneerRx priced it on the day: cents, not per unit.
ALTER TABLE `claims` ADD COLUMN `nadac_dispensed_cents` integer;
--> statement-breakpoint
ALTER TABLE `claims` ADD COLUMN `dir_fee_cents` integer;
--> statement-breakpoint
ALTER TABLE `claims` ADD COLUMN `evoucher_cents` integer;
--> statement-breakpoint
-- The contract id the plan itself returned on the claim (NCPDP 5.1/D.0 response), primary payer.
ALTER TABLE `claims` ADD COLUMN `contract_id` text;
--> statement-breakpoint
ALTER TABLE `claims` ADD COLUMN `gcn` text;
--> statement-breakpoint
-- The day the prescription was completed (sold), from the export; the sale the books count.
ALTER TABLE `claims` ADD COLUMN `sold_on` text;
--> statement-breakpoint
-- The export file this row was last enriched from, and when: the proof row re-reads it.
ALTER TABLE `claims` ADD COLUMN `enriched_from` text;
