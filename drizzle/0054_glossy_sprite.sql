CREATE TABLE `payer_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bin` text,
	`pcn` text,
	`group_number` text,
	`contract_id` text,
	`pbm_name` text NOT NULL,
	`contract_doc_id` text,
	`contract_file_name` text,
	`basis` text,
	`confirmed_by` text NOT NULL,
	`confirmed_on` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payer_links_bin_idx` ON `payer_links` (`bin`);--> statement-breakpoint
CREATE INDEX `payer_links_pbm_idx` ON `payer_links` (`pbm_name`);