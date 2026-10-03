CREATE TABLE `intake_items` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`status` text DEFAULT 'extracted' NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`applied_at` text
);
--> statement-breakpoint
CREATE TABLE `obligation_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`completed_on` text NOT NULL,
	`completed_by` text NOT NULL,
	`notes` text,
	`document_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`obligation_id`) REFERENCES `obligations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `obligation_completions_idx` ON `obligation_completions` (`obligation_id`);--> statement-breakpoint
CREATE TABLE `obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`seed_key` text,
	`title` text NOT NULL,
	`detail` text,
	`citation` text,
	`cadence` text NOT NULL,
	`due_on` text,
	`last_completed_on` text,
	`last_completed_by` text,
	`last_notes` text,
	`document_id` text,
	`active` integer DEFAULT true NOT NULL,
	`needs_confirmation` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `obligations_due_idx` ON `obligations` (`due_on`);--> statement-breakpoint
CREATE TABLE `trainings` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`completed_on` text NOT NULL,
	`cycle_year` integer NOT NULL,
	`expires_on` text,
	`provider` text,
	`minutes` integer,
	`document_id` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trainings_person_idx` ON `trainings` (`person_id`);--> statement-breakpoint
CREATE INDEX `trainings_cycle_idx` ON `trainings` (`cycle_year`);