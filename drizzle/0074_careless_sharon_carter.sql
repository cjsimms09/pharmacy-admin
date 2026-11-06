CREATE TABLE `ndc_pack_fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`ndc11` text NOT NULL,
	`pack_size` text NOT NULL,
	`note` text,
	`corrected_by` text NOT NULL,
	`corrected_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ndc_pack_fixes_ndc11_unique` ON `ndc_pack_fixes` (`ndc11`);