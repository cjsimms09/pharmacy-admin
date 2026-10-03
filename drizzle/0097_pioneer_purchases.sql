-- What PioneerRx recorded receiving, which is not an invoice.
--
-- The owner: "we shouldn't be taking pioneer order receipts as invoices, invoices are mailed to us
-- from suppliers and that's what we have to keep... pioneer ordering receipts are not invoices."
--
-- He is right, and the reason the distinction has to be structural rather than a flag on the
-- invoice table is that a flag gets forgotten. Every query over supplier_invoices would have to
-- remember to exclude these, and one that forgot would count the same purchase twice — once from
-- the wholesaler's own invoice and once from PioneerRx's record of receiving it.
--
-- What they are for, in his words: "I more just wanted to use it to catch the money from invoices
-- we didn't get before this was setup in September... But we can use it to make sure we get
-- everything and we read the price right." So: a fallback where no invoice exists, and a check
-- against the invoices that do.
CREATE TABLE `pioneer_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier` text,
	`supplier_id` text,
	`invoice_number` text,
	`invoice_date` text,
	`total_cents` integer,
	`lines` integer,
	`items_text` text DEFAULT '' NOT NULL,
	`read_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pioneer_purchases_number_idx` ON `pioneer_purchases` (`invoice_number`);
--> statement-breakpoint
CREATE INDEX `pioneer_purchases_date_idx` ON `pioneer_purchases` (`invoice_date`);
