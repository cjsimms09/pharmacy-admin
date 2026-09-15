-- The books begin on 1 October 2026. September 2026 was the dry run.
--
-- The owner, 15 September 2026: "books start on 10/01 but we need to do a complete dry run this month to troubleshoot
-- EVERYTHING and make sure everything works starting 10/01". SITE_STARTS_ON moves to 2026-10-01 in books-start.ts in
-- the same commit, and this brings the rows already written under the old date under the new one. The flag is stamped
-- when a row is written, so moving the constant alone would leave every September row counted.
--
-- MERGE AND RUN ON 1 OCTOBER, NOT BEFORE. A migration runs on the next start after it is merged. Merged in September,
-- it would take the dry run's own September money out of every report while the dry run still needs it. A date guard
-- inside the SQL would be worse: run early, it would do nothing and still be marked applied, and never run again.
-- If another migration takes slot 0123 first, renumber this one at merge (see the Drizzle journal note in memory).
--
-- The same rule as 0114, by the day the money arrived, and for the same reason (books-start.ts): money received in
-- October is October's cash whatever fill it paid for.
--   claim_payments        received_on before 2026-10-01
--   cash_receipts         month before 2026-10 (the cash side is kept by month)
--   remittance_holdbacks  received_on before 2026-10-01
-- A row with no date stays counted, as isOutOfBooks treats it.
--
-- Deliberately NOT changed:
--   claim_imports  Flagged by provenance, a test pull (0116). September's imports were real daily reports, and a fill
--                  dispensed on 30 September and collected on 2 October is October revenue: the accrual account slices
--                  on the sold date, so flagging these imports would throw that revenue away.
--   expenses       Not flagged at all; bills count by their own dates on each basis.
UPDATE `claim_payments`
   SET `out_of_books` = 1
 WHERE `received_on` IS NOT NULL
   AND `received_on` < '2026-10-01';
--> statement-breakpoint
UPDATE `cash_receipts`
   SET `out_of_books` = 1
 WHERE `month` < '2026-10';
--> statement-breakpoint
UPDATE `remittance_holdbacks`
   SET `out_of_books` = 1
 WHERE `received_on` IS NOT NULL
   AND `received_on` < '2026-10-01';
