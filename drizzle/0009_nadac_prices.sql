CREATE TABLE `nadac_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`ndc11` text NOT NULL,
	`description` text,
	`unit_micros` integer NOT NULL,
	`pricing_unit` text NOT NULL,
	`effective_on` text NOT NULL,
	`classification` text,
	`otc` integer DEFAULT false NOT NULL,
	`explanation_code` text,
	`file_as_of` text NOT NULL,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nadac_ndc_eff_idx` ON `nadac_prices` (`ndc11`,`effective_on`);--> statement-breakpoint
CREATE INDEX `nadac_file_idx` ON `nadac_prices` (`file_as_of`);