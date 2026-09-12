-- A wholesaler's statement of account, line by line: which invoices are taken, and on what day.
--
-- The owner: "we need to be able to match payments from bank to invoices once we have bank
-- statement" and "make sure system uses it correctly for cash accounting (no duplicates)".
--
-- The duplicate risk is the whole design problem. Every line on a statement is an invoice this
-- site already holds — booking a statement as a cost would count a month's buying twice, and the
-- first one read carries $126,538.20. So nothing here is a cost and nothing here reaches an
-- account as one. These rows say only what the invoices could not: what will actually be debited,
-- and when.
--
-- The unique index is the guard. A statement arriving twice, re-read, or overlapping the previous
-- week's — which McKesson's do, since a statement repeats everything not yet taken — writes each
-- invoice once. The same invoice genuinely re-dated to a later debit is a different row, and
-- that is correct: it moved.
CREATE TABLE supplier_statement_lines (
  id text PRIMARY KEY NOT NULL,
  supplier text NOT NULL,
  supplier_id text,
  -- The wholesaler's own invoice number. What ties this to an invoice already on file.
  invoice_number text NOT NULL,
  billed_on text NOT NULL,
  -- The day the money is taken. Every line sharing it is ONE bank debit, which is the key that
  -- makes a bank line matchable at all: no bank line will ever equal one invoice.
  due_on text NOT NULL,
  gross_cents integer NOT NULL,
  -- The prompt-pay discount. 2.00% on the first statement read, $2,530.77 across 38 invoices —
  -- real money the books had no other way of learning.
  discount_cents integer NOT NULL,
  -- Gross less the discount: what actually leaves the bank, and what cash accounting wants.
  net_cents integer NOT NULL,
  kind text NOT NULL DEFAULT 'Invoice',
  statement_date text,
  -- The statement it was read from, so every figure opens the page it came off.
  document_id text,
  read_at text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX supplier_statement_line_idx ON supplier_statement_lines (supplier, invoice_number, due_on);
--> statement-breakpoint
CREATE INDEX supplier_statement_due_idx ON supplier_statement_lines (due_on);
