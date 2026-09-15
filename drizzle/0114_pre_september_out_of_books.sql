-- The money already in here from before the books begin, brought under the same rule.
--
-- 0113 added the flag and defaulted every existing row to 0, deliberately: adding a column should
-- not silently move half a million dollars. This is the deliberate part, and the owner said yes to
-- it on 11 September 2026 having been shown the figures.
--
-- What it moves out of the books:
--   $519,792.73 of August cash receipts, read from a ProviderPay payment report that was uploaded
--     to test whether payments could be matched to claims. Test data by the same logic as April.
--   $5,541.37 of MTF payments received 18-28 August.
--
-- Why it matters beyond tidiness: August receipts were being counted with no August costs behind
-- them, which is where the phantom August cash profit came from. Revenue whose costs are not in the
-- books is not profit, it is an artefact.
--
-- A payment with no received date is left counted. That matches `isOutOfBooks` in books-start.ts:
-- an undated payment is far likelier to be one arriving now than a deliberate pull of an old month,
-- and silently dropping real revenue is the expensive mistake.
UPDATE `claim_payments`
   SET `out_of_books` = 1
 WHERE `received_on` IS NOT NULL
   AND `received_on` < '2026-09-01';
--> statement-breakpoint
UPDATE `cash_receipts`
   SET `out_of_books` = 1
 WHERE `month` < '2026-09';
