ALTER TABLE `obligation_completions` ADD `period_key` text;--> statement-breakpoint
ALTER TABLE `obligation_completions` ADD `statement` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `kind` text DEFAULT 'attest' NOT NULL;--> statement-breakpoint
ALTER TABLE `obligations` ADD `expected_per_period` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `obligations` ADD `attestation_template` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `witness_source` text;