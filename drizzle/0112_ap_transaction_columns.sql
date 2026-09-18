-- What the wholesaler's own ledger says about each invoice, beyond what the statement of account did.
--
-- The Accounts Payable Open & Closed Transactions report — a weekly zip from era@mckesson.com —
-- carries three things the printed statement does not, and all three are what make a bank line
-- matchable:
--
--   the check number  every invoice cleared under one ACH shares it. "CKACH07227740" covers 27
--                     invoices and $106,322.62. No bank line will ever equal a single invoice, so
--                     without this there is nothing to match a debit against.
--   whether it cleared  "Closed - Cleared" against "Open - Pending Approval". Money gone against
--                     money still to go.
--   the clearing date  when it actually left, which is the cash account's own question.
--
-- Nothing here is a cost. Every row is an invoice already on file or already counted from
-- PioneerRx's receiving record; the report is a second reading of the same money, not more of it.
ALTER TABLE supplier_statement_lines ADD COLUMN check_number text;
--> statement-breakpoint
ALTER TABLE supplier_statement_lines ADD COLUMN clearing_date text;
--> statement-breakpoint
ALTER TABLE supplier_statement_lines ADD COLUMN clearing_document text;
--> statement-breakpoint
ALTER TABLE supplier_statement_lines ADD COLUMN status text;
--> statement-breakpoint
CREATE INDEX supplier_statement_check_idx ON supplier_statement_lines (check_number);
