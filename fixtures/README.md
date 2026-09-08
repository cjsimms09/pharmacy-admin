# Fixtures: the shape of each feed, with nothing real in it

The cloud session can only read what is committed, and real data is never committed. A fixture
is the *shape* of a real file — enough lines to show every kind of row it contains — with every
figure and identifier changed. It lets a reader be written and tested against what actually
arrives rather than what somebody remembers arriving.

## Rules
- Twenty to forty lines of the real file, including the header block, one of each row type, a
  page break if the file has them, and the footer.
- Change every number that identifies anything: prescription numbers, invoice numbers, account
  numbers, delivery document numbers, lot numbers. Prices and quantities may stay.
- Never a patient name, date of birth, phone, address, member id, or person code — not even
  altered. The PioneerRx reports are built without them; if a fixture would need one, the report
  is wrong.
- NDCs may stay: they identify products, not people.
- Name the file for the feed and the supplier, and say in a comment line where the real one
  comes from (the PioneerRx report name, the wholesaler, the email subject pattern).

## What is wanted, and what each unlocks

| File | Source | Unlocks |
|---|---|---|
| `invoice-mckesson.txt` | text layer of a McKesson invoice PDF (`pdfText` output) | confirms the full-row reader; catches an extra column or flag |
| `fda-ndc-product.txt`, `fda-ndc-package.txt` | the FDA NDC Directory (`ndctext.zip`: `product.txt`, `package.txt`, tab-separated) | **committed**, shape only, made-up rows in the real column order; `tests/drug-directory.test.ts` reads them |
| `orange-book-products.txt` | the FDA Orange Book (`EOBZIP`: `products.txt`, tilde-separated) | **committed**, shape only; the AB rating that makes two NDCs substitutable |
| `invoice-ipc.txt` | text layer of an IPC invoice | **committed** — 21 lines, all read, reconciling to the printed total; `tests/invoice-lines.test.ts` reads it |
| `invoice-ipd.txt` | text layer of an IPD invoice | **committed** — and it shows why no rule can read this one: the columns do not survive extraction, so every NDC on a page arrives as one unbroken run of digits. The reader returns nothing from it, correctly; the site reads this layout by sending the document to the model and still requires the arithmetic to hold |
| `catalog-mck.txt` | the scheduled `Mck9_6_2026` export, first supplier block | already covered by `tests/pioneer-catalog.test.ts`; a real header line is still worth having |
| `rx-transactions.txt` | the daily "Rx Transaction Details By Submission Type" report | **committed** — cut from the real 5 Sept 2026 file, identifiers changed; `tests/rx-transactions.test.ts` reads it |
| `rx-transactions-multimonth.txt` | the same report run over a range, which is the shape of the twelve-month history | **committed** — invented identifiers in the real layout: a page break mid-file with the title block repeated, a month boundary inside one payer, a day printed under two payers, two identical transactions on one day, an unknown status, and a grand total whose figures reconcile so that check is actually exercised |
| `on-hand.txt` | a PioneerRx inventory / on-hand export | **committed** — built from what the report designer offers, because no real count has ever arrived; item numbers and quantities invented, NDCs real. Carries a partial bottle, a front-shop barcode, a row with no quantity and an inventory group; `tests/on-hand.test.ts` reads it |
| `nadac-weekly-head.csv` | first ten lines of a CMS weekly file | pins the column spelling the CSV download actually uses |
| `rebate-schedule-mckesson.md` | the OneStop tier ladder, in words, with the ratio definition as the agreement states it | fills in `/suppliers/[id]/terms` correctly; the numbers can be real, they are commercial not personal |
| `return-policy-*.md` | each supplier's return policy, in words | same |
| `contracts/proving-agreement.pdf` | **committed** — not a real file at all: a two-page agreement the site wrote for a plan that does not exist, generated from `src/lib/contract-proving.ts` by `scripts/make-proving-pdf.ts` | "Prove the reader" on Payers → Sort the folder sends it through the exact batch request and marks the answer against what it is known to say; `tests/contract-proving.test.ts` keeps the PDF, the pages and the checks in step |

To get the text layer of a PDF on the pharmacy machine: `npx tsx -e "import {pdfText} from './src/lib/pdf-text'; console.log(pdfText(require('fs').readFileSync('invoice.pdf')))" > fixtures/invoice-mckesson.txt`, then edit the identifiers before committing. The pre-commit hook refuses `.pdf`, `.csv` and `.xlsx` outside this folder; inside it they are allowed, but text is easier to redact and to read.

## payer-payments.csv

The payer payment report, as the remittance service exports it for a date range: one row per
payment, with the payer's own payment number, the day it was deposited, and the amount. Payer names
are replaced with placeholders; the shape, the columns and the arithmetic are the real ones.
