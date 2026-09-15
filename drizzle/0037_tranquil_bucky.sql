CREATE TABLE `record_signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`record_key` text NOT NULL,
	`statement` text NOT NULL,
	`content_hash` text,
	`signed_name` text NOT NULL,
	`signed_by_user_id` text NOT NULL,
	`signed_role` text,
	`signed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`signed_ip` text,
	`signed_agent` text,
	`revoked_at` text,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE INDEX `record_signatures_record_idx` ON `record_signatures` (`kind`,`record_key`);