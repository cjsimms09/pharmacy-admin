CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sender_emails` text DEFAULT '' NOT NULL,
	`account_number` text,
	`dea_number` text,
	`phone` text,
	`website` text,
	`expected_schedule` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `suppliers_name_idx` ON `suppliers` (`name`);--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD `total_cents` integer;--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD `supplier_id` text;