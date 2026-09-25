CREATE TABLE `delivery_days` (
	`id` text PRIMARY KEY NOT NULL,
	`on_date` text NOT NULL,
	`deliveries` integer DEFAULT 0 NOT NULL,
	`mail_trips` integer DEFAULT 1 NOT NULL,
	`note` text,
	`entered_by` text NOT NULL,
	`entered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_days_on_date_unique` ON `delivery_days` (`on_date`);--> statement-breakpoint
CREATE INDEX `delivery_days_date_idx` ON `delivery_days` (`on_date`);--> statement-breakpoint
CREATE TABLE `driver_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`invoice_number` text NOT NULL,
	`driver_name` text NOT NULL,
	`rate_cents` integer NOT NULL,
	`deliveries` integer DEFAULT 0 NOT NULL,
	`mail_trips` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`lines_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sent_to` text,
	`sent_at` text,
	`send_error` text,
	`document_id` text,
	`issued_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `driver_invoices_month_idx` ON `driver_invoices` (`month`);