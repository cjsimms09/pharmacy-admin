-- What schedule each invoice line's drug is, and which source said so.
--
-- `controlled` answers one narrow question — is this line in the Schedule II half of an invoice that prints its halves —
-- and only IPD prints them, so 3 lines on the whole site carry it and every other line is null. Null there means "not
-- said", not "not controlled", and reading it as the second produced five false disagreements the first time somebody
-- checked the filing.
--
-- So the line carries its own schedule as a word, with the source beside it: the invoice's own halves, the FDA directory
-- for the NDC, or PioneerRx's receiving record for the delivery — which can only ever prove a negative, because it is
-- about the delivery and not the line. Where none of the three can answer, both stay null and say so.
ALTER TABLE `invoice_lines` ADD COLUMN `dea_schedule` text;
--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD COLUMN `dea_schedule_from` text;
