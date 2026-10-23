CREATE TABLE `drug_directory` (
	`ndc11` text PRIMARY KEY NOT NULL,
	`product_ndc` text NOT NULL,
	`brand_name` text,
	`generic_name` text NOT NULL,
	`substances` text NOT NULL,
	`strength` text NOT NULL,
	`form` text NOT NULL,
	`route` text NOT NULL,
	`labeler` text NOT NULL,
	`application` text,
	`marketing_category` text NOT NULL,
	`dea_schedule` text,
	`package_description` text NOT NULL,
	`equivalence_key` text NOT NULL,
	`te_code` text,
	`te_why` text,
	`marketed_to` text,
	`excluded` integer DEFAULT false NOT NULL,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drug_directory_key_idx` ON `drug_directory` (`equivalence_key`);--> statement-breakpoint
CREATE INDEX `drug_directory_product_idx` ON `drug_directory` (`product_ndc`);--> statement-breakpoint
CREATE TABLE `drug_directory_loads` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`file_as_of` text,
	`loaded_by` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
