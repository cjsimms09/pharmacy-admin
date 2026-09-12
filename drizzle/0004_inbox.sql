CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	`from_address` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`file_name` text,
	`document_id` text,
	`status` text NOT NULL,
	`reason` text,
	`scanned` integer DEFAULT false NOT NULL,
	`swept_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_message_idx` ON `inbox_items` (`message_id`);--> statement-breakpoint
CREATE INDEX `inbox_swept_idx` ON `inbox_items` (`swept_at`);--> statement-breakpoint
ALTER TABLE `documents` ADD `inbox_item_id` text;