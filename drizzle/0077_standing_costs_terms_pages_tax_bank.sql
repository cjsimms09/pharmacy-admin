CREATE TABLE `bank_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`on` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`amount_cents` integer NOT NULL,
	`placed_as` text DEFAULT 'unplaced' NOT NULL,
	`why` text,
	`receipt_id` text,
	`expense_id` text,
	`invoice_id` text,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_lines_key_unique` ON `bank_lines` (`key`);--> statement-breakpoint
CREATE INDEX `bank_lines_on_idx` ON `bank_lines` (`on`);--> statement-breakpoint
CREATE TABLE `standing_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category_id` text,
	`vendor_id` text,
	`amount_cents` integer NOT NULL,
	`paid_day` integer,
	`from_month` text NOT NULL,
	`to_month` text,
	`notes` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `standing_costs_from_idx` ON `standing_costs` (`from_month`);--> statement-breakpoint
ALTER TABLE `contract_docs` ADD `pages` integer;--> statement-breakpoint
ALTER TABLE `network_rates` ADD `effective_to` text;--> statement-breakpoint
ALTER TABLE `sales_months` ADD `retail_tax_cents` integer;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `payment_terms_days` integer;