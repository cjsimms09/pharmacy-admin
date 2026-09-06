CREATE TABLE `recommendation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`subject` text,
	`says` text NOT NULL,
	`todo` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`cadence` text NOT NULL,
	`confidence` text NOT NULL,
	`first_seen_on` text NOT NULL,
	`last_seen_on` text NOT NULL,
	`resolved_on` text,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome_cents` integer,
	`outcome_basis` text,
	`measured_on` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `recommendation_log_key_idx` ON `recommendation_log` (`key`);--> statement-breakpoint
CREATE INDEX `recommendation_log_status_idx` ON `recommendation_log` (`status`);--> statement-breakpoint
ALTER TABLE `contract_text` ADD `source` text DEFAULT 'pdf' NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_groups` ADD `pcn` text;