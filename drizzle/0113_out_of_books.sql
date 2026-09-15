-- Money that arrived before the site's books begin: kept, but never counted.
--
-- The owner, 11 September 2026: "I do not want to track or keep track of payments from before
-- 09/01.. these are test only and should not show up on any AR reports or anything."
--
-- He is about to pull real remittances for April and June to prove that claim matching works. The
-- files are genuine and the matching is the point; the money is not his September books and must
-- not reach a total. A row deleted would test nothing, so the row stays and carries a flag that
-- every money query excludes.
--
-- Keyed on when the money was RECEIVED, not when the fill happened. His words were "payments from
-- before 09/01", and the received-date rule is also the safe one: a September remittance paying an
-- August fill is real money in the books, and a fill-date rule would throw it away.
ALTER TABLE `claim_payments` ADD `out_of_books` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `cash_receipts` ADD `out_of_books` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `claim_payments_out_of_books_idx` ON `claim_payments` (`out_of_books`);
--> statement-breakpoint
CREATE INDEX `cash_receipts_out_of_books_idx` ON `cash_receipts` (`out_of_books`);
