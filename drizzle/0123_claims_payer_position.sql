-- Which payer a claim row is on its fill, and the fill's total price, as PioneerRx states them.
--
-- P-1, 15 September 2026: six September fills carried a primary and a secondary adjudicated under the same BIN, PCN and
-- group, so nothing stored could tell the two claims apart and they read as one plan paying twice. PioneerRx knows
-- (PrimaryClaimID is null on the first payer and set on the later one); the pull used that to pick a row and threw it
-- away. payer_position is 'primary' or 'secondary'; null has not been told, which is not "primary".
--
-- fill_total_price_cents is PioneerRx's RxTransactionFinancial.TotalPricePaid: every payer's NetAmountPaid plus the
-- patient's pay (P-2: true on all 413 voucher fills June to September). It is a fill figure, so it is written on the
-- primary row only and must never be summed across a fill's rows.
ALTER TABLE claims ADD COLUMN payer_position text;
--> statement-breakpoint
ALTER TABLE claims ADD COLUMN fill_total_price_cents integer;
