CREATE TABLE `cs_inventories` (
	`id` text PRIMARY KEY NOT NULL,
	`inventory_date` text NOT NULL,
	`taken_at` text DEFAULT 'close' NOT NULL,
	`time_started` text,
	`time_ended` text,
	`is_ks_annual` integer DEFAULT true NOT NULL,
	`is_dea_biennial` integer DEFAULT false NOT NULL,
	`is_pic_outgoing` integer DEFAULT false NOT NULL,
	`is_pic_incoming` integer DEFAULT false NOT NULL,
	`covers_cii` integer DEFAULT true NOT NULL,
	`covers_ciii_v` integer DEFAULT true NOT NULL,
	`covers_drugs_of_concern` integer DEFAULT true NOT NULL,
	`participant_ids` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cs_inventories_date_idx` ON `cs_inventories` (`inventory_date`);--> statement-breakpoint
ALTER TABLE `documents` ADD `cs_inventory_id` text;