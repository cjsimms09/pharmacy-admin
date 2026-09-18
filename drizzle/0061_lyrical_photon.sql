CREATE TABLE `cash_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`payer` text,
	`notes` text,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cash_receipts_month_idx` ON `cash_receipts` (`month`);--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'operating' NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`notes` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `expense_categories_kind_idx` ON `expense_categories` (`kind`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text,
	`category_id` text,
	`invoice_number` text,
	`invoice_date` text NOT NULL,
	`paid_on` text,
	`amount_cents` integer NOT NULL,
	`tax_cents` integer,
	`description` text,
	`notes` text,
	`document_id` text,
	`inbox_item_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `expenses_date_idx` ON `expenses` (`invoice_date`);--> statement-breakpoint
CREATE INDEX `expenses_paid_idx` ON `expenses` (`paid_on`);--> statement-breakpoint
CREATE INDEX `expenses_category_idx` ON `expenses` (`category_id`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sender_emails` text DEFAULT '' NOT NULL,
	`category_id` text,
	`cadence` text DEFAULT 'irregular' NOT NULL,
	`typical_cents` integer,
	`account_number` text,
	`website` text,
	`notes` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vendors_name_idx` ON `vendors` (`name`);