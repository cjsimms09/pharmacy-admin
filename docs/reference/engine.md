# The engine: every feed the business runs on, what it ties to, and what is still missing

The owner's brief, 7 September 2026: *one engine for the business. The books balance, the claims
balance, the remits balance to the claims. Compliance kept. Profit found. Rebates managed. Every
dollar of spending tracked and reported. As much as possible automated, and the site says clearly
what it is missing or what is not adding up.*

This document is the plumbing diagram for that. One row per feed: the document, how it reaches
the site, what it fills, what it is checked against, and its state today. **A feed marked missing
is the site telling you what it needs.** Kept current by whichever session last changed a feed.

## 1. The three balances

| Balance | Left side | Right side | Where it is checked | State |
|---|---|---|---|---|
| **The claims balance** | this site's margin per fill (remit + patient + later money − acquisition) | PioneerRx's own gross profit on the same rows | Claims page, every fill, to the cent (`fills.ts`) | **Working.** Any fill that disagrees is listed with the gap. |
| **The books balance** | accrual account (what the period earned) | cash account (what reached the bank and left it) | The books, "Earned against banked"; the gap is named as receivable and payable (`ledger.ts`) | **Half working.** The accrual side is complete where the feeds are in. The cash side has no way to enter what was banked (see 2.5), so its revenue is always missing. |
| **Remits balance to claims** | what each payer's remittance advice (835) says it paid, per claim | what the claim was adjudicated for | Only the Medicare facilitator today (`mtf.ts` → `claim_payments`) | **Missing for every commercial payer.** The 835 parser exists (`x12-835.ts`); no path posts a commercial 835 to the fills or to the bank. |

Below those, cost of goods is checked three ways (dispensed cost, purchases, the shelf identity)
and revenue two ways (claims against the till); see `money-ledger.md` §4.

## 2. The feeds

State: **in** = arrives and is used; **partial** = arrives, something is not read or used;
**missing** = the site has nowhere to receive it. "Arrives by" is how it gets here today.

### 2.1 Dispensing and reimbursement

| Feed | Arrives by | Fills | Ties to | State |
|---|---|---|---|---|
| Claims export (PioneerRx transaction detail) | email, daily (`mailbox.ts`) | `claims` → fills, revenue, dispensed cost, scripts | the report's own gross profit; the sales summary | **in** |
| System Sales Summary (the till, by month) | email or upload | `sales_months`: retail before tax, tax collected, patient payments, plan remits | the claims' prescription revenue | **in** — retail was read tax-inclusive until 7 Sept; fixed |
| Facilitator 835s (Medicare Transaction Facilitator) | the MTF CLI, on a cycle | `claim_payments` source `mtf` → the fill; cash receipts by received date | the claim's promised amount | **in** where the CLI is set up |
| Commercial 835s (every other PBM) | dropped on Add documents, or forwarded to the mailbox and "Sort it" pressed | `claim_payments` source `plan` per claim (settling the adjudicated remit, never revenue twice) and the total to `cash_receipts` by the month paid; the file kept as a remittance | the claim's adjudicated remit (the match is what "remits balance to claims" needs next) | **partial** as of 7 Sept: by hand. Enrolment (the routing page) and automatic delivery are the rest; a remittance advice on paper is read by Claude the same way. |
| RxRescue / copay-card credits | email | `claim_payments` | the fill | **in** |
| Plan register (which plans the Kansas floor reaches) | typed on Plans, built from the claims | `plan_groups` | — | **in**, needs the owner's classification of each plan |
| NADAC | fetched weekly from CMS | `nadac_prices` | — | **in** |
| Contracts (PBM agreements) | folder `data/contracts/`, read by Claude | `network_rates`, the payer file, appeal routes, 835 routing facts | the contract's own words, the proving document | **in**, first full read pending |

### 2.2 Buying

| Feed | Arrives by | Fills | Ties to | State |
|---|---|---|---|---|
| Wholesaler invoices (McKesson, IPD, IPC, ParMed) | email (`mailbox.ts`, sender rules) or upload | `supplier_invoices`, `invoice_lines` (NDC, qty, price, class letter, rebate mark) | the shelf; the statement of account; the credit memos | **in**; `paid_on` typed by hand or assumed from terms |
| Supplier statements of account, credit memos | email | filed as documents | the invoices they list | **partial** — filed, not reconciled against the invoices |
| Supplier catalogues (price files) | email or upload | `supplier_items` | — | **in** |
| Rebate breakdown (monthly statement) | email | `suppliers.rebate_statement_json`: the scrubbed ratio, the bands, the money | the site's own estimate from the invoice lines | **partial** — one statement held per supplier, not one per period, so a closed month's estimate can carry this month's band |
| Purchase drill-down (daily ratio) | email, daily | `rebate_ratio_latest` | the statement's scrubbed figure | **in** |
| Balance on hand (the count) | email, daily | `on_hand`, one count kept per month end plus the last week | purchases − dispensed | **in** |
| Return policies | email or typed | `supplier_terms` | — | **in** where typed |
| Supplies (vials, bags, labels) | counts typed; orders emailed | `supplies` | the vendor's invoice, when it comes, as a bill | **in** |

### 2.3 Spending

| Feed | Arrives by | Fills | Ties to | State |
|---|---|---|---|---|
| Vendor bills (rent, utilities, software, insurance…) | email from a known sender (`vendors.sender_emails`), or photographed / dropped on Add documents and read by Claude (vendor, number, date, amount, category; a new vendor added on the card; duplicates refused), or typed | `expenses` with a category and, when paid, a date | the vendor's cadence and typical amount | **in** |
| Standing costs (payroll, rent, the loan) | typed once on Spending | accrued by the day (accrual); on `paid_day` (cash) | the real bill for the month, which replaces the estimate | **in** as of 7 Sept |
| Payroll register (what was actually run) | — | — | the standing payroll cost | **missing** — the payroll provider's report would replace the estimate with the fact each pay day |
| DIR fees and other concessions | typed | `expenses` kind `revenue_offset` | the plan's statement | **partial** — typed, never read from a statement |
| Card processing statement | — | — | — | **missing** — typed as a bill if at all; the processor's statement would derive it |
| Loan principal, draws, equipment, tax | typed | `expenses` kind `balance_sheet` | the loan statement | **in** as of 7 Sept |

### 2.4 The bank

| Feed | Arrives by | Fills | Ties to | State |
|---|---|---|---|---|
| Deposits and payments (the bank's statement) | the bank's CSV export read on the books page ("Read the statement"), or typed | `cash_receipts` by payer and kind (a PBM on the claims, the facilitator, a wholesaler's rebate, card and cash takings); `paid_on` on the one open bill or invoice a payment exactly matches by amount and name; every line kept in `bank_lines` so nothing is banked twice; the rest listed as not placed | every cash-basis figure; the receivable | **in** as of 7 Sept (`bank-statement.ts`, tested). Next: a bank feed rather than an export, and rules for the payers the statement names differently from the claims. |

### 2.5 Compliance and people

| Feed | Arrives by | Fills | State |
|---|---|---|---|
| Licences, certificates, training attestations | upload, email, the training links | `credentials`, `training_records` | **in** |
| Temperatures (iMonnit) | API | `temps` | **in** where connected |
| CQI, inventories, the log, the manual | typed on their pages | their tables | **in** |
| Board and DEA dates | the register (`compliance.ts`) | duties by period | **in** |

## 3. What to build next, in the order the balances need it

1. **Bank in** — done 7 Sept: the bank's CSV export is read on the books page; deposits banked
   by payer, bills and invoices marked paid on the day the money left, every line remembered.
   Next: a bank feed, and payer aliases where the statement's wording differs from the claims.
2. **Commercial 835s** — enrol each PBM (the routing page), receive the files (email or portal
   download), post each payment to its fill and the batch to the bank. This is "remits balance to
   claims".
3. **The intake tool** — built 7 Sept (`business-docs.ts`, Add documents, "Sort it" on the
   Inbox): a wholesaler invoice, a bill, a remittance advice, a rebate statement, a statement or
   credit memo, dropped in or photographed, read by Claude and filed where its money goes with a
   card to check first; an 835 file posts itself. Next: the same for the mailbox automatically,
   once a sender is trusted.
4. **Rebate statements per period** — one row per supplier per month, so a closed month's rebate
   is the wholesaler's figure and the estimate is only ever for the month in progress.
5. **Payroll and card-processing statements** — the two largest costs read from their own
   documents rather than typed.
6. **Supplier statements reconciled to invoices** — every invoice on the statement held, every
   credit memo applied, nothing paid twice.

## 4. How the site says what is missing

- The statement and the books list, per month, every line that is absent before printing a
  bottom line, and mark the account not usable until they are in.
- Money found lists under **blocked** what would put money on the list if it were settled.
- Today carries the feeds that have gone quiet (a supplier that stopped sending, a mailbox that
  stopped reading).
- This document is the whole map; `logic-audit.md` is what was checked and found.
