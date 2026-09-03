CREATE TABLE `training_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`token` text NOT NULL,
	`assigned_on` text NOT NULL,
	`due_on` text NOT NULL,
	`material_url` text,
	`statement` text NOT NULL,
	`completed_at` text,
	`signed_name` text,
	`signed_ip` text,
	`signed_agent` text,
	`training_id` text,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`last_reminder_at` text,
	`sent_at` text,
	`send_error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_assignments_token_unique` ON `training_assignments` (`token`);--> statement-breakpoint
CREATE INDEX `training_assignments_person_idx` ON `training_assignments` (`person_id`);--> statement-breakpoint
CREATE INDEX `training_assignments_due_idx` ON `training_assignments` (`due_on`);--> statement-breakpoint
ALTER TABLE `people` ADD `email` text;--> statement-breakpoint
ALTER TABLE `people` ADD `mobile` text;