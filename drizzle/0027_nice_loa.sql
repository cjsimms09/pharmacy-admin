CREATE TABLE `business_associates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`service` text,
	`contact_name` text,
	`contact_email` text,
	`signed_on` text,
	`expires_on` text,
	`no_expiry` integer DEFAULT false NOT NULL,
	`document_id` text,
	`ended_on` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `business_associates_expires_idx` ON `business_associates` (`expires_on`);--> statement-breakpoint
ALTER TABLE `people` ADD `engagement` text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `starts_on` text;--> statement-breakpoint
ALTER TABLE `people` ADD `ends_on` text;--> statement-breakpoint
ALTER TABLE `people` ADD `affiliation` text;