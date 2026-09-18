-- Which supplier an invoice line belongs to, said rather than guessed.
--
-- earningSoFar matched invoice lines to a supplier by name containment:
--   n === x || n.includes(x) || x.includes(n)
-- The register calls this wholesaler "IPC" and its invoices say "Independent Pharmacy Cooperative".
-- Neither string contains the other, so every one of those lines matched no supplier and dropped
-- out of the rebate arithmetic without a word. Containment is unsafe in the other direction too,
-- and worse there because it yields a figure rather than a gap: the test took the first register
-- row whose name contained the printed one and had no tie-break, so a line printed "IP" would be
-- claimed by whichever of "IPC" and "IPD" the register listed first.
--
-- Two additive columns replace the guess.

-- The spellings a supplier's own paperwork uses for itself, one per line, typed by the pharmacy.
-- Blank means "match on the register name and the catalogue name alone", which is the behaviour
-- that was already there. Nothing is inferred into this column by a migration: an alias is a fact
-- about a trading relationship and the pharmacy is the one that knows it.
ALTER TABLE `suppliers` ADD COLUMN `aliases` text DEFAULT '' NOT NULL;
--> statement-breakpoint

-- The supplier record a line belongs to, carried on the line itself.
--
-- supplier_invoices already resolves this when the invoice is filed, from the sender address —
-- the part a wholesaler's billing system controls. The lines were left holding only the printed
-- name, so every reader downstream had to re-derive from text what the invoice had already
-- settled. Null where the parent invoice never resolved to a register row, which is a gap to be
-- shown rather than a name to be guessed at.
ALTER TABLE `invoice_lines` ADD COLUMN `supplier_id` text;
--> statement-breakpoint

-- Backfill from the parent invoice. This is a copy of a resolved answer, not a new inference.
UPDATE `invoice_lines`
SET `supplier_id` = (
  SELECT `supplier_invoices`.`supplier_id`
  FROM `supplier_invoices`
  WHERE `supplier_invoices`.`id` = `invoice_lines`.`invoice_id`
)
WHERE `supplier_id` IS NULL;
--> statement-breakpoint

CREATE INDEX `invoice_lines_supplier_id_idx` ON `invoice_lines` (`supplier_id`);
