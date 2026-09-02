CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` text,
	`user_name` text,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TABLE `ce_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`completed_on` text NOT NULL,
	`hours_tenths` integer NOT NULL,
	`title` text NOT NULL,
	`provider` text,
	`acpe_number` text,
	`is_board_course` integer DEFAULT false NOT NULL,
	`is_live` integer DEFAULT false NOT NULL,
	`document_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ce_person_idx` ON `ce_entries` (`person_id`);--> statement-breakpoint
CREATE TABLE `cqi_cap_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`review_number` integer NOT NULL,
	`effective` integer,
	`comments` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `cqi_incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`summary_id`) REFERENCES `cqi_summaries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cap_reviews_incident_idx` ON `cqi_cap_reviews` (`incident_id`);--> statement-breakpoint
CREATE INDEX `cap_reviews_summary_idx` ON `cqi_cap_reviews` (`summary_id`);--> statement-breakpoint
CREATE TABLE `cqi_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_number` integer NOT NULL,
	`occurred_on` text NOT NULL,
	`report_created_on` text NOT NULL,
	`type` text NOT NULL,
	`type_other` text,
	`description` text NOT NULL,
	`rx_numbers_enc` text,
	`reached_patient` integer,
	`review_started_on` text,
	`review_completed_on` text,
	`employee_communication` text,
	`root_cause_analysis` text,
	`corrective_action_plan` text,
	`cap_implemented_on` text,
	`reviewer_person_id` text,
	`employee_reviews` text DEFAULT '[]' NOT NULL,
	`cap_closed` integer DEFAULT false NOT NULL,
	`external_report_ref` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cqi_incidents_incident_number_unique` ON `cqi_incidents` (`incident_number`);--> statement-breakpoint
CREATE INDEX `cqi_incidents_created_idx` ON `cqi_incidents` (`report_created_on`);--> statement-breakpoint
CREATE TABLE `cqi_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`due_on` text NOT NULL,
	`is_null_report` integer DEFAULT false NOT NULL,
	`is_historical` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`incident_ids` text DEFAULT '[]' NOT NULL,
	`prior_cap_evaluation` text,
	`additional_notes` text,
	`prepared_by_person_id` text,
	`prepared_on` text,
	`communicated_on` text,
	`communication_method` text,
	`communicated_to` text DEFAULT '[]' NOT NULL,
	`finalized_at` text,
	`finalized_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cqi_summaries_period_idx` ON `cqi_summaries` (`period_start`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`type` text NOT NULL,
	`label` text,
	`number` text,
	`issuer` text,
	`issued_on` text,
	`expires_on` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credentials_person_idx` ON `credentials` (`person_id`);--> statement-breakpoint
CREATE INDEX `credentials_expires_idx` ON `credentials` (`expires_on`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`person_id` text,
	`credential_id` text,
	`cqi_summary_id` text,
	`cqi_incident_id` text,
	`effective_on` text,
	`expires_on` text,
	`notes` text,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `documents_person_idx` ON `documents` (`person_id`);--> statement-breakpoint
CREATE INDEX `documents_category_idx` ON `documents` (`category`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text NOT NULL,
	`title` text,
	`is_pic` integer DEFAULT false NOT NULL,
	`administers_vaccines` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`hired_on` text,
	`ended_on` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'staff' NOT NULL,
	`person_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);