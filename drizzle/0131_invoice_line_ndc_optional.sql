-- An invoice line can carry no NDC, because some of them do not have one.
--
-- IPD 1018194, 24 September 2026: `1435700 1 0EACH 239.99  0  239.99` — EPINEPHRINE, seven digits
-- of item number where every other line on that page carried sixteen digits of item number and NDC
-- run together. The reader required eleven, so the line did not match at all: it was neither read
-- nor counted as unreadable, and the invoice reported four lines, nought unread, and $239.99 short
-- of its own printed total. The morning check caught the shortfall; nothing said which line.
--
-- A line with no NDC is an ordinary thing on a wholesaler's invoice and nothing should be invented
-- for it. The column was NOT NULL, which left only bad answers: drop the line and understate the
-- invoice, or put the item number in the NDC column and have every NDC-keyed figure read a code
-- that is not one. So the column becomes optional, which is what the paper actually says.
--
-- SQLite cannot drop a NOT NULL, so the table is rebuilt. Every column, default, foreign key and
-- index is reproduced exactly as it stood; only `ndc11` changes.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `invoice_lines_new` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`supplier` text,
	`invoice_date` text,
	`ndc11` text,
	`description` text,
	`item_number` text,
	`quantity` integer NOT NULL,
	`unit_of_measure` text,
	`unit_cost_cents` integer NOT NULL,
	`extended_cents` integer NOT NULL,
	`awp_cents` integer,
	`item_class` text,
	`rebated` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`supplier_id` text,
	`controlled` integer,
	`dea_schedule` text,
	`dea_schedule_from` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `supplier_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `invoice_lines_new` (`id`,`invoice_id`,`supplier`,`invoice_date`,`ndc11`,`description`,`item_number`,`quantity`,`unit_of_measure`,`unit_cost_cents`,`extended_cents`,`awp_cents`,`item_class`,`rebated`,`created_at`,`supplier_id`,`controlled`,`dea_schedule`,`dea_schedule_from`)
SELECT `id`,`invoice_id`,`supplier`,`invoice_date`,`ndc11`,`description`,`item_number`,`quantity`,`unit_of_measure`,`unit_cost_cents`,`extended_cents`,`awp_cents`,`item_class`,`rebated`,`created_at`,`supplier_id`,`controlled`,`dea_schedule`,`dea_schedule_from` FROM `invoice_lines`;
--> statement-breakpoint
DROP TABLE `invoice_lines`;
--> statement-breakpoint
ALTER TABLE `invoice_lines_new` RENAME TO `invoice_lines`;
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`);
--> statement-breakpoint
CREATE INDEX `invoice_lines_ndc_idx` ON `invoice_lines` (`ndc11`);
--> statement-breakpoint
CREATE INDEX `invoice_lines_supplier_idx` ON `invoice_lines` (`supplier`);
--> statement-breakpoint
CREATE INDEX `invoice_lines_supplier_id_idx` ON `invoice_lines` (`supplier_id`);
--> statement-breakpoint
CREATE INDEX `invoice_lines_date_idx` ON `invoice_lines` (`invoice_date`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
