CREATE TABLE `plan_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`bin` text,
	`group_number` text,
	`payer_label` text,
	`pbm_name` text,
	`sponsor_name` text,
	`classification` text DEFAULT 'unknown' NOT NULL,
	`basis` text,
	`source_url` text,
	`decided_by` text,
	`decided_on` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_groups_key_idx` ON `plan_groups` (`bin`,`group_number`);--> statement-breakpoint
CREATE INDEX `plan_groups_class_idx` ON `plan_groups` (`classification`);