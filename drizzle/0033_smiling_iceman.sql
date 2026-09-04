CREATE TABLE `manual_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`section_title` text NOT NULL,
	`severity` text DEFAULT 'should' NOT NULL,
	`what` text NOT NULL,
	`why` text NOT NULL,
	`suggested_body` text DEFAULT '' NOT NULL,
	`applied_at` text,
	`dismissed_at` text,
	`dismissed_reason` text,
	`closed_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `manual_findings_section_idx` ON `manual_findings` (`section_id`);--> statement-breakpoint
ALTER TABLE `manual_sections` ADD `audited_on` text;