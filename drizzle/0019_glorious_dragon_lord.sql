CREATE TABLE `temp_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`sensor_id` text NOT NULL,
	`period_key` text NOT NULL,
	`reading_id` text,
	`note` text NOT NULL,
	`reviewed` integer DEFAULT false NOT NULL,
	`written_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`sensor_id`) REFERENCES `temp_sensors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `temp_notes_sensor_period_idx` ON `temp_notes` (`sensor_id`,`period_key`);--> statement-breakpoint
CREATE TABLE `temp_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`sensor_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`period_key` text NOT NULL,
	`value_tenths_f` integer NOT NULL,
	`excursion` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`sensor_id`) REFERENCES `temp_sensors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `temp_readings_sensor_period_idx` ON `temp_readings` (`sensor_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `temp_readings_taken_idx` ON `temp_readings` (`sensor_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `temp_sensors` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`external_name` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'refrigerator' NOT NULL,
	`tracked` integer DEFAULT false NOT NULL,
	`min_tenths_f` integer DEFAULT 360 NOT NULL,
	`max_tenths_f` integer DEFAULT 460 NOT NULL,
	`last_reading_at` text,
	`last_sync_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `temp_sensors_external_id_unique` ON `temp_sensors` (`external_id`);--> statement-breakpoint
CREATE INDEX `temp_sensors_tracked_idx` ON `temp_sensors` (`tracked`);