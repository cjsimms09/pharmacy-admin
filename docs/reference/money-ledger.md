# The money ledger: cash and accrual, what each figure is drawn from, and what ties to what

The Money section is the pharmacy's set of books. This document says, for every figure it prints,
which record it comes from on each basis, which other record must agree with it, what happens when
they do not, and what the page must let a person do about it. The arithmetic is in
`src/lib/profit-and-loss.ts` (one month) and `src/lib/ledger.ts` (periods, pace, counts), both
pure and tested by hand-worked figures. Every unit here is the data dictionary's: money in cents,
never a float.

## 1. The two bases, and why both are kept

**Accrual** answers what the period earned: a prescription dispensed on the 30th belongs to that
month whatever month the plan pays in. **Cash** answers what reached the bank and left it. A
pharmacy is paid two to four weeks in arrears and pays its wholesaler on terms, so the two differ
every month, and the difference is the receivable and the payable — real money, and worth a figure
of its own. Neither basis is the default view; the page states which it is showing and never mixes
lines from the two.

## 2. Every figure, its source on each basis, and what it must never be

| Figure | Accrual source | Cash source | Second record it is checked against | Never |
|---|---|---|---|---|
| Prescription revenue | System Sales Summary (`sales_months`) — the till, by calendar month. Falls back to the claims (Σ plan remit + patient total per fill) and says so. | `cash_receipts` entered from the bank, by the month the money arrived; facilitator money from `claim_payments.received_on` where the receipt list is empty | claims vs till (expected to differ by the front of shop only) | claims *added to* the till (every script twice); copay column as patient money |
| Retail / OTC | System Sales Summary retail line | `cash_receipts` kind `retail` | none; named as missing when the summary is absent | inferred from anything |
| Facilitator and top-off money | `claim_payments` by the fill's month (earned) | `claim_payments` by `received_on` (banked) | the fill it paid | counted under both revenue and the fill's remit |
| DIR fees, chargebacks | `expenses` with category kind `revenue_offset`, by invoice date | same, by `paid_on` — and a fee the plan took out of a remittance carries **no paid date**, because the smaller deposit already shows it | none; empty is named as "not entered", never as "none" | filed as an overhead; a netted fee with a paid date (twice on the cash account) |
| Cost of goods | Σ `claims.acquisition_cents` once per fill, for fills dated in the period | Σ `supplier_invoices.total_cents` by the day the money left: `paid_on` where recorded; else the invoice date plus the supplier's `payment_terms_days`; else the invoice date. The statement says how many are on an assumed date. Never nought for want of a date. | opening stock + invoiced purchases − closing stock (`on_hand_imports`, Rx shelf) | the invoice total as accrual cost; NADAC as any cost; the report's printed gross profit |
| Wholesaler rebates | `earningSoFar()`: the period's invoice lines × the ladder rate in force, per supplier — **until the wholesaler's statement is entered on Spending under "Wholesaler rebates", which replaces the estimate** | `cash_receipts` kind `rebate`; a statement entered as a bill with a paid date is dropped where a receipt is in | the wholesaler's statement | booked as revenue; the estimate and the statement together; the receipt and the bill together |
| Operating expenses | `expenses` by invoice date, by category, plus each `standing_costs` row's share of the month by calendar day (30,000 of payroll is 10,000 by the 10th; the whole figure once the month is over), dropped where a bill from the same vendor — or, for a cost with no vendor, a bill in the same category — is in for the month | `expenses` by `paid_on`; a standing cost in full on its `paid_day` and not before, and **left out and named where no paid day is set** (an accrual is not cash) | the vendor's typical amount and cadence (`vendors`) | wholesaler invoices entered here as well (they are left out and named); a standing cost and its bill in the same month; a standing cost accrued by the day on the cash account |
| Loan principal, owner draws, equipment bought, income tax | Nothing. Category kind `balance_sheet`: profit is stated before them, and the interest, the depreciation and the tax expense have lines of their own | `expenses` of kind `balance_sheet` by `paid_on`, below net cash from operations; **cash change** is the figure after them | the loan statement, the bank | counted as a cost on either basis; left out of the cash account |
| Delivery round | The month's driver invoices (`driver_invoices`, raised by the site from the days entered), as an operating line — the month in progress carries the draft's running total, the same way payroll is carried by the day; a superseded invoice never counts (`driver-cost.ts`). Nothing only where Settings says the clinic pays the driver directly (`driver_paid_by = clinic`), and then the statement's "known to the site, and not in this account" card names the round and its figure. | a sent invoice on the day it was sent, the nearest record the site holds of when the driver was paid; a draft is not cash | the invoice PDF filed on send | a draft on the cash account; counted while the clinic pays it |
| Scripts | fills (one per bottle, `fills.ts`), dated in the period; cash fills counted apart | same | the claim import's own count | transmissions (a coordinated fill is one script) |
| Stock movement | invoiced purchases − dispensed cost | — | the shelf counts | added to profit |

## 3. Periods and pace

A period is a month (`2026-09`), a quarter (`2026-Q3`) or a year (`2026`). A period's figures are
the sum of its months' figures, line by line; the margin percentage is recomputed on the sums,
never averaged. What is missing in any month is listed against that month, and the period's bottom
line is marked usable only when every month's is.

**Month to date** is the current month's account through today. Beside it the page shows the
*pace*: dispensing revenue and gross profit scaled from the days elapsed to the whole month, said as
"at this pace". Operating costs are not paced — bills land on their own days — so the paced net
profit is dispensing pace less the bills already in, and is labelled as that.

## 4. What ties to what

Every check is a row on the page with the two figures, the difference, and whether a difference
is expected (`reconcile.ts`):

1. **Bought against dispensed** (accrual): invoices in the month against dispensed cost. Expected to
   differ; the difference is stock movement.
2. **The shelf against the claims**: opening + purchases − closing against dispensed cost. Not
   expected to differ beyond $1. A difference is a finding: a fill with no acquisition cost, an
   invoice filed twice, a count that missed a shelf.
3. **The claims against the till**: prescription revenue from the claims against the summary's
   prescription lines. Expected to differ only by timing of a re-sent day.
4. **The bank against the claims** (cash): what was banked against what was adjudicated. Expected
   to differ; the difference is the receivable, reported as a figure.
5. **Scripts against the report**: the fills counted against the import's own count.

A source that duplicates another (the claims and the sales summary both carry prescriptions; the
driver invoice and a hand-entered delivery bill) is never summed; the rule in §2 says which wins and
the page names the one it dropped.

## 5. Auditable, and correctable

Every figure on the dashboard and the statement links to the rows it was added from: revenue and
cost of goods to the claims for the period; purchases to the invoices; each expense category to
Spending filtered to the period and category; rebates to the supplier's terms; scripts to the
claims. Where the figure is wrong the fix is on the linked page (edit or void the expense, mark the
invoice paid, correct the plan), never on the statement itself. The statement is a reading of the
records, and a reading is corrected by correcting the record.

## 6. Reports

- The statement for any period and basis, on screen, printable, and as CSV
  (`/api/ledger?period=2026-Q3&basis=accrual`): one row per line with the group, label, cents
  and note.
- Month-to-date on any day, with pace.
- The last six months side by side: net revenue, gross profit, operating, net, scripts — the chart
  on the dashboard, each bar a link to that month's statement.
- Accrual and cash side by side for the same period, with the receivable and payable named.

## 7. What is not built yet, in order

1. `rebate_statements` (one row per supplier per period) so the cash rebate is read from the
   statement rather than typed.
2. Commercial 835s, so cash revenue from plans is derived rather than entered.
3. A balance sheet: AR ageing from the fills on account and the remittances awaited; AP from
   invoices with no `paid_on`.
4. Budgets and variance against the same lines.

## 8. The accountant's audit of 7 September, and what it changed

The owner asked whether accrual shows what was earned and cash shows what the bank did. Read
through as an accountant would, four things were wrong and are fixed; the rest are rules the
person entering figures has to keep, and the page now says them where the figure is typed.

1. **Standing costs were accrued onto the cash account.** Payroll by the day is an accrual; on
   the cash account nothing has left until pay day. Now: `standing_costs.paid_day`; the cash
   account counts the whole figure on that day and not before, and a cost with no paid day is
   left out and named, never estimated. A bill for it in the same category (or from its vendor)
   replaces it on either basis, so payroll typed and payroll entered are one figure.
2. **Money that leaves and is not a cost had nowhere to go.** A loan payment typed under Interest
   made the principal an expense; left out, the cash account missed real money. Now: category
   kind `balance_sheet` (Loan principal; Owner draws and distributions; Equipment and improvements
   bought; Income tax payments). Absent from the accrual account, where profit is before them;
   below "Net cash from operations" on the cash account, with **Cash change** after them.
3. **The rebate estimate and the rebate statement could both count.** The statement entered on
   Spending now replaces the estimate; on the cash basis a receipt of kind `rebate` wins over the
   same statement entered as a bill.
4. **A wholesaler invoice filed on Spending counted twice.** Bills under "Drug purchases" are left
   out on both bases and named on the statement, with where they belong.

Rules the figures depend on, now said on the category or the form: a DIR fee or card fee the
payer netted out of a deposit is entered with no paid date; depreciation is entered with no paid
date; payroll paid twice a month is two standing costs; a loan payment is interest (a cost) and
principal (not) as two rows. Still not derived and worth building next: the receivable from the
835s rather than typed receipts (§7.2), and a sales-tax line on the sales summary so retail is
net of tax collected.
