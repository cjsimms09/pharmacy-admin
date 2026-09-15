-- PioneerRx's System Sales Totals By Payment Type, one row per period the report was run for.
--
-- The owner sends it daily from 15 September 2026. It is the only record of how a day's takings were
-- paid (card, cash, cheque, charged to an account), which is what lets a card batch be checked against
-- the till to the cent. Nothing is booked from it on either basis; see sales-by-payment.ts.
--
-- Keyed by the period, so a day re-run after a correction replaces its row rather than doubling it.
CREATE TABLE `sales_by_payment` (
	`period` text PRIMARY KEY NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`printed_on` text,
	`cash_cents` integer NOT NULL,
	`check_cents` integer NOT NULL,
	`card_cents` integer NOT NULL,
	`account_cents` integer NOT NULL,
	`coupons_cents` integer NOT NULL,
	`returns_cash_cents` integer NOT NULL,
	`returns_card_cents` integer NOT NULL,
	`returns_account_cents` integer NOT NULL,
	`returns_coupons_cents` integer NOT NULL,
	`card_net_cents` integer NOT NULL,
	`retail_cents` integer NOT NULL,
	`retail_tax_cents` integer NOT NULL,
	`rx_patient_cents` integer NOT NULL,
	`rx_remit_cents` integer NOT NULL,
	`adjustments_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
