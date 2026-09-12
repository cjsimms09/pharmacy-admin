CREATE TABLE `cash_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`bin` text NOT NULL,
	`pcn` text,
	`name` text NOT NULL,
	`note` text,
	`added_by` text,
	`added_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cash_plans_bin_idx` ON `cash_plans` (`bin`);
--> statement-breakpoint
INSERT INTO `cash_plans` (`id`, `bin`, `pcn`, `name`, `note`, `added_by`)
VALUES (
	'cash-plan-rxlocal',
	'028249',
	'RXLOCAL',
	'Pharm D (RxLocal)',
	'The pharmacy''s own cash plan. The owner: "There is no third party remit from pharmd. Whatever the copay is is the only money we receive." A claim on it is never owed by anybody, so it is never a receivable, and any remit PioneerRx shows against it is a discount the pharmacy gave rather than money coming in.',
	'system'
);
