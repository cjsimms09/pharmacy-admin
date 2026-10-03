ALTER TABLE `suppliers` ADD `no_rebates` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `no_rebates_by` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `no_rebates_at` text;