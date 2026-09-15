-- Which programme a claim's copay voucher came from, and the amount PioneerRx read from its message.
--
-- Measured 15 September against Veridikal's own eVoucher report: on 67 of its 74 voucher rows the claim's
-- Prescription.Claim.EvoucherAmountFromMessage equals the report's voucher amount, while EvoucherAmountPaid (the
-- column evoucher_cents holds) is zero on 66. RedSail's switch vouchers carry EvoucherAmountPaid. So the voucher a
-- claim carries is in one column or the other depending on who ran the programme, and which one ran it is told by
-- the message's wording. The message itself is not stored: it carries the patient's remaining benefit.
--
-- Null until the next PioneerRx pull fills them; a null programme has not been read, which is not "no voucher".
ALTER TABLE claims ADD COLUMN evoucher_message_cents integer;
--> statement-breakpoint
ALTER TABLE claims ADD COLUMN evoucher_programme text;
