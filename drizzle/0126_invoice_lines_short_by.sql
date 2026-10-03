-- What an invoice's item lines are short by, named on the invoice rather than left as an absence.
--
-- The owner, 16 September 2026: "ipd sends controlled and non controlled items in same document, they are different
-- invoices but in the same pdf". That is what these three columns are for.
--
-- Until now the rule was all or nothing: if the lines read did not come to the total printed, every line was thrown away.
-- On IPD 1013225 that meant the Schedule II half — one line, $1,077.40, read perfectly and proved against its own printed
-- subtotal — was discarded because the non-controlled half was $112.77 short on two lines the reader did not know. The
-- DEA asks about the half that was thrown away.
--
-- So each half is now judged against its own subtotal and kept on its own merits, and what a half is short by is recorded
-- here: the amount, how many lines it is missing, and which half in words. An invoice is then short by a named amount
-- instead of absent, and the page can ask for the one thing a person has to look at.
ALTER TABLE `supplier_invoices` ADD COLUMN `lines_short_cents` integer;
--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD COLUMN `lines_short_count` integer;
--> statement-breakpoint
ALTER TABLE `supplier_invoices` ADD COLUMN `lines_short_note` text;
