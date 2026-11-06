CREATE TABLE `claims_aging` (
	`id` text PRIMARY KEY NOT NULL,
	`as_of` text NOT NULL,
	`payer_name` text NOT NULL,
	`bin` text NOT NULL,
	`d0_30` real DEFAULT 0 NOT NULL,
	`d31_60` real DEFAULT 0 NOT NULL,
	`d61_90` real DEFAULT 0 NOT NULL,
	`d91_120` real DEFAULT 0 NOT NULL,
	`d121_150` real DEFAULT 0 NOT NULL,
	`d151_180` real DEFAULT 0 NOT NULL,
	`over_180` real DEFAULT 0 NOT NULL,
	`total_out` real DEFAULT 0 NOT NULL,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claims_aging_bin_idx` ON `claims_aging` (`bin`);--> statement-breakpoint
CREATE INDEX `claims_aging_asof_idx` ON `claims_aging` (`as_of`);--> statement-breakpoint
CREATE TABLE `contract_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`document_name` text NOT NULL,
	`document_type` text,
	`effective_year` integer,
	`file_name` text,
	`size_bytes` integer,
	`sha256` text,
	`matched_by` text,
	`priority` integer DEFAULT false NOT NULL,
	`extraction_state` text DEFAULT 'none' NOT NULL,
	`extraction_json` text,
	`extraction_error` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contract_docs_pbm_idx` ON `contract_docs` (`pbm_name`);--> statement-breakpoint
CREATE INDEX `contract_docs_priority_idx` ON `contract_docs` (`priority`);--> statement-breakpoint
CREATE TABLE `payer_bins` (
	`id` text PRIMARY KEY NOT NULL,
	`bin` text NOT NULL,
	`pbm_name` text NOT NULL,
	`sub_network` text,
	`lines_of_business` text,
	`aliases` text,
	`help_desk` text,
	`mac_contact` text,
	`notes` text,
	`collides` integer DEFAULT false NOT NULL,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payer_bins_bin_idx` ON `payer_bins` (`bin`);--> statement-breakpoint
CREATE INDEX `payer_bins_pbm_idx` ON `payer_bins` (`pbm_name`);