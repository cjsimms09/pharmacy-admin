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