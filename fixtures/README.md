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
| `invoice-ipc.txt` | text layer of an IPC invoice | reading IPC lines in full (today: NDC + amount only) |
| `invoice-ipd.txt` | text layer of an IPD invoice | same for IPD, plus the per-schedule subtotals |
| `catalog-mck.txt` | the scheduled `Mck9_6_2026` export, first supplier block | already covered by `tests/pioneer-catalog.test.ts`; a real header line is still worth having |
| `rx-transactions.txt` | the daily "Rx Transaction Details By Submission Type" report | already covered by `tests/rx-transactions.test.ts` |
| `nadac-weekly-head.csv` | first ten lines of a CMS weekly file | pins the column spelling the CSV download actually uses |
| `rebate-schedule-mckesson.md` | the OneStop tier ladder, in words, with the ratio definition as the agreement states it | fills in `/suppliers/[id]/terms` correctly; the numbers can be real, they are commercial not personal |
| `return-policy-*.md` | each supplier's return policy, in words | same |

To get the text layer of a PDF on the pharmacy machine: `npx tsx -e "import {pdfText} from './src/lib/pdf-text'; console.log(pdfText(require('fs').readFileSync('invoice.pdf')))" > fixtures/invoice-mckesson.txt`, then edit the identifiers before committing. The pre-commit hook refuses `.pdf`, `.csv` and `.xlsx` outside this folder; inside it they are allowed, but text is easier to redact and to read.
