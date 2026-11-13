CREATE TABLE `supplier_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`supplier` text,
	`invoice_number` text,
	`invoice_date` text,
	`schedule` text DEFAULT 'unknown' NOT NULL,
	`basis` text,
	`controlled_items` text DEFAULT '' NOT NULL,
	`needs_review` integer DEFAULT true NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`received_from` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_invoices_schedule_idx` ON `supplier_invoices` (`schedule`);--> statement-breakpoint
CREATE INDEX `supplier_invoices_date_idx` ON `supplier_invoices` (`invoice_date`);