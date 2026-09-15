CREATE TABLE `self_inspection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`inspection_id` text NOT NULL,
	`item_key` text NOT NULL,
	`result` text NOT NULL,
	`note` text,
	`corrective_action` text,
	`corrected_on` text,
	`corrected_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`inspection_id`) REFERENCES `self_inspections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `self_inspection_items_idx` ON `self_inspection_items` (`inspection_id`);--> statement-breakpoint
CREATE TABLE `self_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`started_on` text NOT NULL,
	`completed_on` text,
	`completed_by` text,
	`period_key` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
