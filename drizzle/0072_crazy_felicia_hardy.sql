CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`claim_id` text,
	`rx_number` text,
	`fill_number` integer,
	`date_filled` text,
	`ndc11` text,
	`pbm_name` text NOT NULL,
	`claim_ids` text,
	`shortfall_cents` integer DEFAULT 0 NOT NULL,
	`deadline` text,
	`status` text DEFAULT 'prepared' NOT NULL,
	`channel` text,
	`target` text,
	`packet_json` text NOT NULL,
	`document_id` text,
	`sent_at` text,
	`sent_by` text,
	`send_result` text,
	`response_due_on` text,
	`outcome_cents` integer,
	`outcome_note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `appeals_claim_idx` ON `appeals` (`claim_id`);--> statement-breakpoint
CREATE INDEX `appeals_pbm_idx` ON `appeals` (`pbm_name`);--> statement-breakpoint
CREATE INDEX `appeals_status_idx` ON `appeals` (`status`);--> statement-breakpoint
CREATE TABLE `era_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`delivery_target` text,
	`requested_on` text,
	`requested_to` text,
	`confirmed_on` text,
	`first_remit_on` text,
	`document_id` text,
	`notes` text,
	`updated_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `era_enrollments_pbm_idx` ON `era_enrollments` (`pbm_name`);