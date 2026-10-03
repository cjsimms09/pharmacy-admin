CREATE TABLE `claim_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text,
	`rx_number` text NOT NULL,
	`fill_number` integer,
	`date_filled` text,
	`ndc11` text,
	`source` text NOT NULL,
	`payer` text,
	`amount_cents` integer NOT NULL,
	`received_on` text,
	`reference` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `claim_payments_claim_idx` ON `claim_payments` (`claim_id`);--> statement-breakpoint
CREATE INDEX `claim_payments_rx_idx` ON `claim_payments` (`rx_number`);--> statement-breakpoint
ALTER TABLE `claims` ADD `patient_total_cents` integer;