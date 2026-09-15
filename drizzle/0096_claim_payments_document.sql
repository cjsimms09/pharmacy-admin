-- The document a payment was read out of, so a wrong reading can be taken back out.
--
-- A remittance loaded as the wrong kind of document — the owner's own worst case, asked which of
-- the things that can go wrong worries him most — writes claim payments and a bank deposit. The
-- deposit could always be deleted on the Money page. The payments could not: nothing on any screen
-- lists them, and nothing anywhere removes them, so a wrong load left money attached to fills for
-- good and the only trace of where it came from was a sentence in `notes`.
--
-- `reference` is the payer's own check number and is not that handle: a statement that prints no
-- check number has none, and two statements can share one. The document is the thing that was
-- loaded, so the document is what an undo is keyed on. Null for every payment recorded before this,
-- which is why the undo says plainly when it cannot reach a payment rather than deleting by guess.
ALTER TABLE `claim_payments` ADD COLUMN `document_id` text;
--> statement-breakpoint
CREATE INDEX `claim_payments_document_idx` ON `claim_payments` (`document_id`);
