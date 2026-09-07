# Logic audit: every figure on every page, traced to its source

Started 7 September 2026 after the owner asked whether the books can be trusted. For each page:
what each figure is drawn from, the rule that places it in a period, what it is checked against,
and what was found. A finding is either **fixed** (with the commit) or **rule** (a fact the person
entering data has to keep, now said on the page where it is entered) or **open** (needs a source
the site does not have yet). Read `money-ledger.md` for the accounting model itself.

## Money

### The books `/money`, the statement `/money/monthly`, over time `/money/report`

Engine: `profit-and-loss.ts` (one month), `ledger.ts` (periods, pace, the two bases side by
side), `standing-math.ts`, `reconcile.ts`. The statement and the books read the same `MonthlyPL`.

| Figure | Source and rule | Finding |
|---|---|---|
| Revenue, accrual | System Sales Summary by calendar month; the claims (remit + patient paid per fill) stand in when it is absent, never as well; facilitator money by the fill's month is added | Sound. **Open:** whether PioneerRx's summary already carries facilitator payments as adjustments is unknown; the claims-against-till check (§4.3 of the ledger) would show it as a standing difference. **Open:** the summary's retail line may include sales tax collected, which is a liability, not revenue; the sales reader needs the tax line. |
| Revenue, cash | `cash_receipts` typed by month; facilitator money by `received_on` where no receipt of that kind is typed | Sound as far as it goes. The receivable is only as good as the typing; 835s (§7.2) would derive it. |
| DIR, chargebacks | `expenses` kind `revenue_offset`, invoice date on accrual, `paid_on` on cash | **Rule:** a fee the plan netted out of a remittance is entered with no paid date; the smaller deposit already shows it. Said on the category. |
| Cost of goods, accrual | Σ acquisition cost per fill, dated in the month | Sound. Note the acquisition cost is the price on file at fill time, not the invoice price of that bottle; the difference is caught by the shelf check (opening + purchases − closing). |
| Cost of goods, cash | Σ supplier invoice totals by `paid_on`, else date + terms, else date; assumed dates counted and said | Sound. |
| Rebates | Accrual: the ladder estimate from the month's invoice lines; cash: receipts of kind `rebate` | **Fixed:** the statement entered on Spending replaced nothing and counted on top of the estimate. It now replaces it; on cash a receipt wins over the same statement as a bill. |
| Drug purchases filed as a bill | `expenses` under "Drug purchases" | **Fixed:** counted on top of the supplier invoices on both bases. Now left out and named on the statement. |
| Operating, accrual | `expenses` by invoice date + standing costs by calendar day, replaced by the vendor's bill | **Fixed:** a standing cost with no vendor was never replaced, so payroll typed and payroll entered both counted. A bill in the same category now replaces it. |
| Operating, cash | `expenses` by `paid_on` | **Fixed:** standing costs were accrued by the day onto the cash account — an accrual, not cash — and a payroll bill paid on the 3rd of the next month then counted again there. Now the whole figure on `paid_day`, nothing before it, and left out and named where no paid day is set. |
| Loan principal, draws, equipment, tax | Nowhere | **Fixed:** category kind `balance_sheet`; absent on accrual, below the line on cash, with Cash change after them. |
| Depreciation | "Equipment and depreciation", operating | **Rule:** entered with no paid date, so the cash account never sees it. Said on the category. |
| Net, cash basis | was labelled "Net profit" | **Fixed:** "Net cash from operations", then "Cash change". |
| Stock movement | invoice lines − dispensed cost | Sound; never in profit. |
| Pace | dispensing scaled by days elapsed; bills not scaled | Sound; said as such. |
| Periods | months added line by line; margin recomputed on sums | Sound. |
| Usable | false while wages, rent, card fees or DIR are absent | Sound; conservative. |

### Still open on Money
- 835 remittances → cash revenue derived, and the receivable aged (ledger §7).
- Sales tax on the summary's retail line.
- `period-account.ts` (the pharmacy session's) and `loadShared` both exist; one should absorb the other (HANDOFF).
