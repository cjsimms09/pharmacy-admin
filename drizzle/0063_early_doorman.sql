CREATE TABLE `on_hand` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`counted_on` text NOT NULL,
	`ndc11` text NOT NULL,
	`description` text,
	`item_number` text,
	`quantity_thousandths` integer NOT NULL,
	`unit` text,
	`unit_cost_micros` integer,
	`value_cents` integer,
	FOREIGN KEY (`import_id`) REFERENCES `on_hand_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `on_hand_counted_idx` ON `on_hand` (`counted_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `on_hand_counted_ndc_idx` ON `on_hand` (`counted_on`,`ndc11`);--> statement-breakpoint
CREATE TABLE `on_hand_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`counted_on` text NOT NULL,
	`file_name` text NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`items_kept` integer DEFAULT 0 NOT NULL,
	`skip_reasons` text DEFAULT '{}' NOT NULL,
	`unmapped_columns` text DEFAULT '[]' NOT NULL,
	`units_thousandths` integer DEFAULT 0 NOT NULL,
	`value_cents` integer,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `on_hand_imports_counted_idx` ON `on_hand_imports` (`counted_on`);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `minimum_order_cents` integer;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `free_freight_cents` integer;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `freight_cents` integer;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `lead_time_days` integer;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `primary_supplier` integer DEFAULT false NOT NULL;