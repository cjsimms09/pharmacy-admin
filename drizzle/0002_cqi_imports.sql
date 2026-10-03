CREATE TABLE `cqi_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`status` text DEFAULT 'extracted' NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`applied_at` text
);
