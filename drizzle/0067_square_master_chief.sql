PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_on_hand` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`counted_on` text NOT NULL,
	`code` text NOT NULL,
	`code_kind` text DEFAULT 'ndc11' NOT NULL,
	`ndc11` text,
	`description` text,
	`item_number` text,
	`inventory_group` text,
	`quantity_thousandths` integer NOT NULL,
	`on_order_thousandths` integer,
	`pack_qty` integer,
	`counted_in_packages` integer DEFAULT false NOT NULL,
	`unit` text,
	`unit_cost_micros` integer,
	`value_cents` integer,
	FOREIGN KEY (`import_id`) REFERENCES `on_hand_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_on_hand`("id", "import_id", "counted_on", "code", "code_kind", "ndc11", "description", "item_number", "inventory_group", "quantity_thousandths", "on_order_thousandths", "pack_qty", "counted_in_packages", "unit", "unit_cost_micros", "value_cents") SELECT "id", "import_id", "counted_on", "ndc11", 'ndc11', "ndc11", "description", "item_number", NULL, "quantity_thousandths", NULL, NULL, 0, "unit", "unit_cost_micros", "value_cents" FROM `on_hand`;--> statement-breakpoint
DROP TABLE `on_hand`;--> statement-breakpoint
ALTER TABLE `__new_on_hand` RENAME TO `on_hand`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `on_hand_counted_idx` ON `on_hand` (`counted_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `on_hand_counted_code_idx` ON `on_hand` (`counted_on`,`code`);--> statement-breakpoint
CREATE INDEX `on_hand_ndc_idx` ON `on_hand` (`ndc11`);--> statement-breakpoint
ALTER TABLE `on_hand_imports` ADD `rx_value_cents` integer;