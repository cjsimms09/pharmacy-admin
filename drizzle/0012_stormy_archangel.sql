CREATE TABLE `claim_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`claims_added` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`skip_reasons` text DEFAULT '{}' NOT NULL,
	`unmapped_columns` text DEFAULT '[]' NOT NULL,
	`period_from` text,
	`period_to` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`rx_number` text NOT NULL,
	`fill_number` integer,
	`date_filled` text NOT NULL,
	`ndc11` text,
	`item_name` text,
	`bin` text,
	`pcn` text,
	`group_number` text,
	`network_id` text,
	`plan_id` text,
	`plan_type` text,
	`pharmacy_service_type` text,
	`basis_of_reimbursement` text,
	`basis_of_cost_determination` text,
	`payer_label` text,
	`pbm_name` text,
	`match_method` text,
	`payer_ambiguous` integer DEFAULT false NOT NULL,
	`quantity_thousandths` integer,
	`quantity_unit` text,
	`days_supply` integer,
	`remit_cents` integer,
	`copay_cents` integer,
	`awp_cents` integer,
	`acquisition_cents` integer,
	`gross_profit_cents` integer,
	`ingredient_paid_cents` integer,
	`dispensing_fee_paid_cents` integer,
	`daw` text,
	`raw_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `claim_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `claims_import_idx` ON `claims` (`import_id`);--> statement-breakpoint
CREATE INDEX `claims_pbm_idx` ON `claims` (`pbm_name`);--> statement-breakpoint
CREATE INDEX `claims_bin_idx` ON `claims` (`bin`);--> statement-breakpoint
CREATE INDEX `claims_date_idx` ON `claims` (`date_filled`);--> statement-breakpoint
CREATE INDEX `claims_rx_idx` ON `claims` (`rx_number`);