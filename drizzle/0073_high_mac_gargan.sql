CREATE TABLE `supplier_item_fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier` text NOT NULL,
	`ndc11` text NOT NULL,
	`pack_size` text,
	`unit_cost_micros` integer,
	`note` text,
	`corrected_by` text NOT NULL,
	`corrected_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_item_fixes_key_idx` ON `supplier_item_fixes` (`supplier`,`ndc11`);