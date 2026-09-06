CREATE TABLE `sales_months` (
	`month` text PRIMARY KEY NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`retail_cents` integer,
	`rx_patient_cents` integer,
	`rx_remit_cents` integer,
	`rx_cents` integer,
	`total_cents` integer,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`file_name` text,
	`printed_on` text,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
