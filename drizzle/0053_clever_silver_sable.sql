CREATE TABLE `contract_text` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`contract_doc_id` text,
	`sha256` text NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contract_text_file_idx` ON `contract_text` (`file_name`);