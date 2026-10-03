-- A register of remittances, so cash and claims can be told when they fall out of step.
--
-- On 18 September 2026 the accrual side was overstated by $28,645.57 and the cash side understated
-- by $99,238.84 at the same moment, and nothing on any screen said either. The owner found both.
--
-- They were the same absence. The site holds claim payments (what each prescription earned) and
-- cash receipts (what was deposited), and nothing joins them: a remittance's own number, what it
-- came to, and the payer's payment number that the deposit will carry. Without that, "this
-- remittance has been posted but its money has never been banked" is not a question anything can
-- ask, so a fortnight of deposits went missing in silence.
--
-- This holds no money and feeds no account. It is a register: one row per remittance, carrying the
-- payment number that the cash receipt will also carry, so the two can be compared. A payment
-- number of NULL is ProviderPay saying it has not matched the remittance to a deposit yet, which
-- is a real state and means no cash should be expected for it.
CREATE TABLE `remittance_register` (
	`id` text PRIMARY KEY NOT NULL,
	`remit_number` text NOT NULL,
	`payer_name` text NOT NULL,
	`remit_on` text,
	`amount_cents` integer NOT NULL,
	`payment_number` text,
	`source` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remittance_register_number_idx` ON `remittance_register` (`remit_number`);
--> statement-breakpoint
CREATE INDEX `remittance_register_payment_idx` ON `remittance_register` (`payment_number`);
