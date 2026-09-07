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

## Money found `/money/found` and the rows it draws from

| Row | Source | Finding |
|---|---|---|
| Buying from a cheaper supplier; dispensed at a loss | `product-ledger.ts`: invoice price per unit less the supplier's rate where the line is marked rebated, against every catalogue's effective price; margins on the units dispensed | **Fixed:** the fill's revenue left out money that reached it later (facilitator refunds), so every Part D brand with a refund landed read as dispensed at a loss. Note: cost here is the latest invoice price net of rebate applied to every unit dispensed in the period, while the Claims page costs each fill at PioneerRx's acquisition cost; both are said on their pages. |
| Next rebate band; band at risk | `ratio-effect.ts` on the month's invoice lines at the primary | **Fixed:** the ratio's denominator was every line on the invoices, over-the-counter included; the compliance ratio is measured on prescription purchases, so the spend a band needs was overstated. Now the lines carrying a class letter, where the invoice prints them. **Fixed:** the brand factor was applied to every "not rebated" line, OTC included. Simplification kept and said: the band's worth is the rate difference on the month's contract generics so far, not projected to month end, and not counting the rate the extra spend itself would earn; both understate. |
| Rebate estimate on the books | `earningSoFar` | **Fixed:** used today's ladders for any month asked for; now the ladders in force at the end of that month. **Open:** the ratio that picks the band is the latest known (one statement is held per supplier, not one per period), so a closed month's estimate can carry this month's band until `rebate_statements` exist (ledger §7.1). |
| Returns closing | `returns-due.ts`: days since the invoice against the supplier's credit steps, less the restocking fee | Sound. Nothing for a supplier without a policy on file, said. |
| Kansas floor | was `claimFlags.underFee` | **Fixed (two faults):** the row was called "paid below the Kansas floor" but summed a different thing — fills that received less than the $10.50 fee alone; and that test ran per claim row, so the secondary leg of a coordinated fill ($0 paid because the primary paid) counted as under the fee by the whole $10.50. The row now carries the floor page's own figure: NADAC in force on the fill date plus the fee, per fill, on claims that pass every check. The under-fee sieve on the Claims page is judged per fill. |
| Payer spread | `payer-map.ts`: best against worst plan per drug, cards excluded | Marked "worth checking", as it should be: plans buy different things. |
| Totals | `totals()` counts each overlapping problem once | Sound. |

## What to buy `/purchasing`, the shelf, the minimums, Which contract

| Figure | Source | Finding |
|---|---|---|
| Order quantity | `toOrderThousandths`: (target days + lead time) × rate, less on hand and on order, whole units | **Fixed:** the lead time used was `Math.min(...leads, 1)`, never more than a day, so a three-day supplier's order was sized two days short. Now the shortest lead on file, and never under a day. |
| Offers | catalogue price less the supplier's rate where the line is rebated | **Fixed:** any flag at all counted as rebated, so a line the catalogue marked "not rebated" got the discount and could beat the contract line. **Fixed:** the generic catalogue importer stored the file's own word (Y, N, …), which neither comparison recognised, so no line from that path ever carried its discount; the flag is normalised on import (`contractFlagOf`). |
| Moving a basket off the primary | `bandCostOfMoving`: the whole basket treated as contract generics | Conservative by design, said in code; denominator now prescription lines. |
| Minimum filler | `minimum-filler.ts` | Sound: generics by CMS flag, controlled excluded, cheapest here after rebate, whole packs inside the horizon, overshoot said. |
| Which contract | `contract-replay.ts`: each fill at the supplier's cheapest equivalent, ladder at the replayed month's unscrubbed ratio | Sound as far as the data allows; the unscrubbed ratio understates every ladder equally, and the table now follows the ranking (coverage first). |
| Driver invoices | trips × rate | Sound. |
