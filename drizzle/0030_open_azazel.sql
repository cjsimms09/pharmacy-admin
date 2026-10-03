CREATE TABLE `manual_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text,
	`source` text DEFAULT 'pharmacy' NOT NULL,
	`title` text NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`position` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`reviewed_on` text,
	`reviewed_by` text,
	`retired_on` text,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `manual_sections_pos_idx` ON `manual_sections` (`position`);