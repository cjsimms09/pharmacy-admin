-- Claims loaded as a test, kept and matchable, never counted.
--
-- The owner is pulling August claims so the August 835s have something to match against, and August
-- is not his books: "i will not be uploading claims from before sept.. or anything. this site is
-- starting clean as of 09/01/.."
--
-- Flagged on the import rather than on each claim, because it is a fact about where the rows came
-- from and not about any one of them. A date rule on the claim itself would be wrong in exactly the
-- way the fill-date rule was wrong for payments: a fill dispensed on 31 August and collected on
-- 2 September is real September revenue, and a rule keyed on when it was filled would throw it away.
-- Provenance does not have that problem — an import pulled to test matching is a test whatever dates
-- its rows carry.
--
-- Slot 0115 is left free for another session working in this repo at the same time.
ALTER TABLE `claim_imports` ADD `out_of_books` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `claim_imports_out_of_books_idx` ON `claim_imports` (`out_of_books`);
