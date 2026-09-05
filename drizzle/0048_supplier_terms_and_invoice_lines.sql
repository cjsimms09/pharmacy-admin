CREATE TABLE `supplier_invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`kind` text DEFAULT 'product' NOT NULL,
	`ndc11` text,
	`raw_ndc` text,
	`supplier_item_number` text,
	`description` text,
	`quantity` integer,
	`unit` text,
	`unit_price_cents` integer,
	`extended_cents` integer,
	`awp_cents` integer,
	`item_class` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `supplier_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_invoice_lines_invoice_idx` ON `supplier_invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoice_lines_ndc_idx` ON `supplier_invoice_lines` (`ndc11`);--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_invoice_lines_invoice_line_uq` ON `supplier_invoice_lines` (`invoice_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `supplier_rebate_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`name` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`terms_version` integer DEFAULT 1 NOT NULL,
	`terms_json` text NOT NULL,
	`document_id` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_rebate_programs_supplier_idx` ON `supplier_rebate_programs` (`supplier_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `supplier_return_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`name` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`terms_version` integer DEFAULT 1 NOT NULL,
	`terms_json` text NOT NULL,
	`document_id` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_return_policies_supplier_idx` ON `supplier_return_policies` (`supplier_id`,`effective_from`);--> statement-breakpoint
ALTER TABLE `supplier_imports` ADD `supplier_id` text;--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD `lines_read` integer;--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD `lines_unread` integer;--> statement-breakpoint
ALTER TABLE `supplier_items` ADD `supplier_id` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `catalog_name` text;