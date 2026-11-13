ALTER TABLE `claims` ADD `status` text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE `claims` ADD `reversed_on` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `transaction_key` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `reversal_key` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `source` text DEFAULT 'export' NOT NULL;--> statement-breakpoint
CREATE INDEX `claims_txn_idx` ON `claims` (`transaction_key`);--> statement-breakpoint
CREATE INDEX `claims_reversal_idx` ON `claims` (`reversal_key`);--> statement-breakpoint
CREATE INDEX `claims_status_idx` ON `claims` (`status`);