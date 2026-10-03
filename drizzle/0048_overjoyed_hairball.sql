CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`supplier` text,
	`invoice_date` text,
	`ndc11` text NOT NULL,
	`description` text,
	`item_number` text,
	`quantity` integer NOT NULL,
	`unit_of_measure` text,
	`unit_cost_cents` integer NOT NULL,
	`extended_cents` integer NOT NULL,
	`awp_cents` integer,
	`item_class` text,
	`rebated` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `supplier_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_ndc_idx` ON `invoice_lines` (`ndc11`);--> statement-breakpoint
CREATE INDEX `invoice_lines_supplier_idx` ON `invoice_lines` (`supplier`);