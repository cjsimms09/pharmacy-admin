CREATE TABLE `cs_discrepancies` (
	`id` text PRIMARY KEY NOT NULL,
	`discovered_on` text NOT NULL,
	`drug_name` text NOT NULL,
	`ndc11` text,
	`strength` text,
	`schedule` text DEFAULT 'unknown' NOT NULL,
	`expected_thousandths` integer,
	`counted_thousandths` integer,
	`unit` text DEFAULT 'EA' NOT NULL,
	`narrative` text NOT NULL,
	`resolution` text,
	`resolved_on` text,
	`cs_inventory_id` text,
	`reported_to_dea` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cs_discrepancies_date_idx` ON `cs_discrepancies` (`discovered_on`);--> statement-breakpoint
CREATE INDEX `cs_discrepancies_drug_idx` ON `cs_discrepancies` (`drug_name`);