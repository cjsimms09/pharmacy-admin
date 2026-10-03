CREATE TABLE `supplier_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier` text NOT NULL,
	`file_name` text NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`items_added` integer DEFAULT 0 NOT NULL,
	`items_updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`skip_reasons` text DEFAULT '{}' NOT NULL,
	`unmapped_columns` text DEFAULT '[]' NOT NULL,
	`priced_on` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplier_items` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier` text NOT NULL,
	`ndc11` text NOT NULL,
	`description` text,
	`product_key` text,
	`manufacturer` text,
	`pack_size` text,
	`unit_cost_micros` integer,
	`pack_cost_cents` integer,
	`contract_flag` text,
	`availability` text,
	`priced_on` text,
	`import_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_items_ndc_idx` ON `supplier_items` (`ndc11`);--> statement-breakpoint
CREATE INDEX `supplier_items_key_idx` ON `supplier_items` (`product_key`);--> statement-breakpoint
CREATE INDEX `supplier_items_supplier_idx` ON `supplier_items` (`supplier`);