CREATE TABLE `invoice_forwards` (
	`id` text PRIMARY KEY NOT NULL,
	`to_address` text NOT NULL,
	`invoice_ids` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`included_schedule_two` integer DEFAULT false NOT NULL,
	`note` text,
	`sent_by` text NOT NULL,
	`sent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `invoice_forwards_sent_idx` ON `invoice_forwards` (`sent_at`);--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD `items_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `supplier_invoices_supplier_idx` ON `supplier_invoices` (`supplier`);