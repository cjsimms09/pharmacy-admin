CREATE TABLE `credential_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`reply_code` text NOT NULL,
	`requested_on` text NOT NULL,
	`requested_by` text,
	`sent_at` text,
	`send_error` text,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`fulfilled_at` text,
	`document_id` text,
	`credential_id` text,
	`cancelled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credential_requests_person_idx` ON `credential_requests` (`person_id`);--> statement-breakpoint
CREATE INDEX `credential_requests_code_idx` ON `credential_requests` (`reply_code`);