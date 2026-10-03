-- Why a payer paid less than the claim said it would.
--
-- The 835 answers this in every file and the site was throwing the answer away. CAS segments carry
-- the reason per claim, PLB carries what was held back from the whole remittance, and the parser
-- reads both -- but `recordClaimPayment` never took them, so a short payment was only ever "short".
-- A difference nobody can explain is indistinguishable from a contractual write-off, and the owner
-- had no way to tell a fee from money he was owed.
--
-- The owner, 11 September 2026: "lets just track PI's and account for it where we need to (in
-- accounting) but show the claim as reconciled... should be easy to see claim is reconciled and here
-- is the reason we didnt get what we expected."
--
-- So a claim is reconciled when every dollar is accounted for -- paid plus explained adjustments
-- equals adjudicated -- and the reasons are shown beside it. Only an unexplained residue is a
-- finding.
CREATE TABLE `payment_adjustments` (
  `id` text PRIMARY KEY NOT NULL,
  `payment_id` text NOT NULL REFERENCES `claim_payments`(`id`) ON DELETE cascade,
  -- CAS01. CO contractual, PR patient responsibility, PI payer initiated, OA other.
  `group_code` text NOT NULL,
  -- The reason code as the payer printed it. Never interpreted at write time.
  `reason_code` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `quantity` integer,
  -- "claim" or "service". A CAS in the claim loop and one in the service loop for the same reason
  -- are different money, and flattening them double-counts exactly the large deductions.
  `loop` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `payment_adjustments_payment_idx` ON `payment_adjustments` (`payment_id`);
--> statement-breakpoint
CREATE INDEX `payment_adjustments_group_idx` ON `payment_adjustments` (`group_code`);
--> statement-breakpoint
-- Money taken off a whole remittance that belongs to no single claim: DIR, GER reconciliation,
-- recoupments, transaction fees.
--
-- Kept apart from the claim-level table because it cannot be allocated to a claim without inventing
-- the allocation. It reconciles the deposit, never a prescription. It has a booking month and no
-- service month, and that is a fact about the money rather than a gap in the data.
CREATE TABLE `remittance_holdbacks` (
  `id` text PRIMARY KEY NOT NULL,
  -- The remittance's trace number, so it ties to the payments that came with it.
  `trace_number` text,
  `payer` text,
  `reason_code` text NOT NULL,
  -- PLB03-2: the payer's own reference, which is what somebody quotes when they ring to ask.
  `reference` text,
  -- As printed. A positive amount REDUCES what the payer sent.
  `amount_cents` integer NOT NULL,
  `received_on` text,
  `document_id` text,
  `file_name` text,
  -- Money from before the books begin is kept and never counted, as everywhere else.
  `out_of_books` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `remittance_holdbacks_trace_idx` ON `remittance_holdbacks` (`trace_number`);
--> statement-breakpoint
CREATE INDEX `remittance_holdbacks_received_idx` ON `remittance_holdbacks` (`received_on`);
--> statement-breakpoint
CREATE UNIQUE INDEX `remittance_holdbacks_once_idx` ON `remittance_holdbacks` (`trace_number`, `reason_code`, `reference`, `amount_cents`);
