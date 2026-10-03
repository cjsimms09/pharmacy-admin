-- The payer payment report: what the plans actually put in the bank, banked once.
--
-- A payment report is a date range and a date range gets re-run, so every receipt that came from
-- one carries the payer's own payment number keyed against the payer. Without that identity this
-- file would inflate revenue every time it landed.
ALTER TABLE `cash_receipts` ADD `source_key` text;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `received_on` text;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `reference` text;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `method` text;--> statement-breakpoint
-- Recorded and not yet used: the beginning of the 835 work, not part of it.
ALTER TABLE `cash_receipts` ADD `remit_matched` integer;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `claim_match_cents` integer;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `no_claim_match_cents` integer;--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `adjustments_cents` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `cash_receipts_source_key_unique` ON `cash_receipts` (`source_key`);--> statement-breakpoint
CREATE INDEX `cash_receipts_received_idx` ON `cash_receipts` (`received_on`);
