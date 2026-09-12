-- The cloud branch's `supplier_invoice_lines` table is deliberately not created here.
-- Both sessions built an invoice line reader in the same week. The one kept is `invoice_lines`
-- from migration 0048, because it reconciles each invoice against the total printed on its face
-- and carries the K flag McKesson prints against a line bought on the generics contract — the one
-- fact that decides whether a price gets the tier rate taken off it. Two tables holding the same
-- lines would drift, and the comparison would read whichever it happened to be pointed at.
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