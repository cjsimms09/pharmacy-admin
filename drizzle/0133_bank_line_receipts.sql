-- Every receipt a bank line confirmed, not only the first.
--
-- A bank line has one `receipt_id`. A counter deposit is the register's four days; a ProviderPay deposit is
-- three payers' remittances paid in together; the McKesson rebate is three credits against one receipt. The
-- line kept the first receipt and named the rest in `why`, and the match context, asking "which receipts has
-- a line already confirmed", read only the column — so the other three register days looked unconfirmed, the
-- next counter deposit's run started from them, and 30 September 2026's deposit could not place after the
-- 23rd's had. Found 1 October, placing the owner's answers.
--
-- Additive. The column stays, as the first of the set; this table carries the whole set.
CREATE TABLE `bank_line_receipts` (
  `line_id` text NOT NULL REFERENCES `bank_lines`(`id`) ON DELETE CASCADE,
  `receipt_id` text NOT NULL,
  PRIMARY KEY (`line_id`, `receipt_id`)
);
--> statement-breakpoint
CREATE INDEX `bank_line_receipts_receipt_idx` ON `bank_line_receipts` (`receipt_id`);
