CREATE TABLE `supply_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`counted_on` text NOT NULL,
	`quantity` real NOT NULL,
	`counted_by` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `supply_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supply_counts_item_day_idx` ON `supply_counts` (`item_id`,`counted_on`);--> statement-breakpoint
CREATE TABLE `supply_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT 'box' NOT NULL,
	`per_unit` integer,
	`vendor_id` text,
	`supplier_code` text,
	`lead_time_days` integer DEFAULT 5 NOT NULL,
	`safety_days` integer DEFAULT 7 NOT NULL,
	`target_days` integer DEFAULT 45 NOT NULL,
	`order_multiple` integer,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `supply_items_active_idx` ON `supply_items` (`active`);--> statement-breakpoint
CREATE TABLE `supply_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` real NOT NULL,
	`received_quantity` real,
	FOREIGN KEY (`order_id`) REFERENCES `supply_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `supply_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supply_order_lines_order_idx` ON `supply_order_lines` (`order_id`);--> statement-breakpoint
CREATE INDEX `supply_order_lines_item_idx` ON `supply_order_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `supply_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text,
	`vendor_name` text NOT NULL,
	`sent_to` text,
	`placed_on` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`body` text,
	`sent_at` text,
	`send_error` text,
	`received_on` text,
	`placed_by` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `supply_orders_status_idx` ON `supply_orders` (`status`);