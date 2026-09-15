-- A payment to a supplier, and how much of it went against each invoice.
--
-- A paid date on an invoice holds one day per invoice, and the suppliers without a ledger feed do not pay that way. The
-- owner, 15 September 2026: "believe parmed and ipd are per statement". Parmed takes one ACH for a half-month of invoices,
-- listed on its portal's "bills paid with one payment" page. IPD settles its invoices by offset against Aytu credit
-- memos, and sometimes in part: its statement shows one invoice paid $1,125.36 on 19 August and $2,152.03 on 3 September.
-- The cash account counts each part in the month it was paid (cash-cogs.ts), which needs the amount per invoice.
--
-- Additive. Nothing existing changes; supplier_invoices.paid_on is still the day an invoice was paid in full.
CREATE TABLE `supplier_payments` (
  `id` text PRIMARY KEY NOT NULL,
  `supplier` text NOT NULL,
  -- The day the money left, or the day the offset was applied.
  `paid_on` text NOT NULL,
  -- What the payment was for, as the bank, the portal or the statement prints it.
  `amount_cents` integer NOT NULL,
  -- offset, ach, cheque, card or unknown.
  `method` text DEFAULT 'unknown' NOT NULL,
  -- The supplier's own number for it: IPD's Payment Ref, Parmed's payment number. Null where none was given.
  `reference` text,
  -- An offset's credit memo, as the statement names it.
  `credit_memo` text,
  -- hand, ipd_statement, parmed_portal or bank_debit.
  `source` text NOT NULL,
  -- How the allocations were known: document (the supplier's own page or statement lists them), hand (a person ticked
  -- them against a payment), or inferred (a rule chose them, to be replaced when the supplier's document arrives).
  `basis` text DEFAULT 'document' NOT NULL,
  -- What makes a second reading of the same payment a no-op.
  `source_key` text NOT NULL,
  `document_id` text,
  `notes` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_payments_source_key_idx` ON `supplier_payments` (`source_key`);
--> statement-breakpoint
CREATE INDEX `supplier_payments_paid_on_idx` ON `supplier_payments` (`paid_on`);
--> statement-breakpoint
-- One payment's amount against one invoice. A payment can pay many invoices, and an invoice can be paid by many payments.
CREATE TABLE `supplier_payment_allocations` (
  `id` text PRIMARY KEY NOT NULL,
  `payment_id` text NOT NULL REFERENCES `supplier_payments`(`id`) ON DELETE cascade,
  `invoice_id` text NOT NULL REFERENCES `supplier_invoices`(`id`) ON DELETE cascade,
  `amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_payment_allocations_payment_idx` ON `supplier_payment_allocations` (`payment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_payment_allocations_once_idx` ON `supplier_payment_allocations` (`payment_id`, `invoice_id`);
--> statement-breakpoint
-- The day the invoice says it will be taken, as printed on it.
--
-- Not a rule this site works out. Parmed prints "PAYMENT TERMS : Semi mthly 15/EOM" and a DUE DATE on every invoice, and
-- all six of September's print 10/10/2026 — which is what its two portal payments did (17–29 July taken 25 August, 3–14
-- August taken 10 September). IPD's statement prints a due date per invoice too. So which invoices one ACH pays is on the
-- documents, and nothing has to be guessed from sums.
ALTER TABLE `supplier_invoices` ADD COLUMN `due_on` text;
