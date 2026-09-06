# Data dictionary: what every figure is, and what it may be used for

The engine in `profit-engine.md` is only as good as its understanding of each number. This is the
rule book: for every figure the site holds, its unit, where it comes from, what it means, and,
most important, **what it must never be used for**. A module that applies a figure outside its
"use for" line is wrong even if its arithmetic is right. New figures are added here before they
are used anywhere.

Units: money is integer **cents**; a unit price is **micros** (millionths of a dollar);
quantities are **thousandths** of a unit; dates are ISO text. A figure crossing from micros to
cents is divided by 10,000; a per-unit figure times a quantity in thousandths, divided by 1,000,
gives units.

## 1. The daily transaction report (PioneerRx, one row per transmission)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Amount (`remitCents`) | cents | What this payer remitted on this transmission. Negative on a reversal. | fill revenue (summed over the fill's live rows); pay basis; floor check | a fill's whole price on its own (a secondary row's Amount is a residual) |
| Copay (`copayCents`) | cents | The copay the plan assessed. Zero on a deductible fill where the patient in fact owes everything. | nothing on its own | patient revenue; it is what was handed on to the next payer, not money |
| Total (`patientTotalCents`) | cents | What the patient was left owing after this adjudication. | patient share of the fill (summed over live rows; flagged if two rows both carry one) | adding to Amount on a coordinated row and calling that the fill's price |
| Dispensing Fee | cents | The fee inside Amount. | the ingredient-cost identity | adding to Amount (it is already in it) |
| Ingredient cost paid (derived) | cents | Amount + Total − Dispensing Fee (NCPDP identity). | pay basis; NADAC comparison per unit | a figure to reconcile against the report (the report does not print it) |
| Acq. Inv. Cost (`acquisitionCents`) | cents | PioneerRx's cost for the bottle, on the row that dispensed it; zero on coordination rows. | fill cost, taken once per fill | a supplier price (it is PioneerRx's, not the invoice's); summing across a fill's rows |
| GrossProfit (printed) | cents | PioneerRx's own margin **including its estimated rebate and estimated DIR** (the header says so). | completeness check of the file against its grand total; the layout evidence | margin. The site's margin is Amount + Total − Acq per fill; the printed figure differs on rows with an estimate (four on the real 5 Sept file, 18¢ to $1.02) |
| QTY | thousandths | Units dispensed on this transmission; negative on a reversal. | units per fill, taken once | summing across a fill's rows |
| Completed Date (`completedAt`) | date | When the fill was sold, as of the report's printing. A property of the fill, not the row. | reporting; nothing selects on it | deciding whether to store the row (the row never comes round again) |
| Status P / A / R | | Paid, reversal, rejected. | P stores a claim; A cancels the claim it negates; R is counted | treating an A whose claim is not held as a loss (it is stored as reversed, unmatched, and excluded from fills) |
| Rx-fill, BIN, PCN, Group, Ntw Reim. Id | | Identity of the prescription and the payer route. | the fill key (rx, fill, date, NDC); the plan key (BIN, group); links to contract | a BIN alone as a plan (one BIN carries many plans) |
| Cash plan (BIN 028249, "PharmD") | flag | The pharmacy's own cash programme. | margin and cash pricing | floor review, appeals, payer ranking (there is no payer) |
| Transaction key | | rx, fill, status, date, BIN, NDC, remit, copay, qty, plus an ordinal for identical rows. | de-duplication across re-sent days | matching a reversal (that is by negated figures, not by key) |

## 2. Invoices (supplier PDFs, read to lines)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Unit cost (`unitCostCents`) | cents **per package** | What the invoice charged for one package as it prices it. | the pharmacy's paid price, once converted per unit | comparing with a catalogue or NADAC before dividing by the pack size |
| Pack size (`packQty`) | units | Units in the package the invoice prices, from the catalogue. | converting invoice price to per unit | guessing when absent: the row is excluded and says so |
| Extended, and the invoice's printed total | cents | The line and the whole. | the reconciliation that decides whether lines are stored at all | — |
| Rebated flag (McKesson's K) | flag | The line earns the OneStop generic rebate. | taking the tier rate off **this line's** price | inferring from the product; only a document says it |
| Supplier | | Who sold it. | the rate that applies (rates are per supplier) | applying one supplier's rate to another's line |

## 3. Catalogues (PioneerRx export of each supplier's price file, weekly)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Unit price (`unitCostMicros`) | micros **per unit** | What the supplier lists per dispensing unit. | the offered price per unit | comparing with an invoice line before that line is per unit |
| Pack size | text | "(10) 100 EA": the bracket is the order multiple, the number is the pack. | pack size for invoice conversion | reading the bracket as the pack (divides every price by ten) |
| Contract flag ("Rebate Pck Cost" present) | flag | McKesson marks OneStop items; IPD and IPC print the column blank. | rebated on McKesson lines | assuming a blank means "not rebated" at IPD or IPC (unknown, not no) |
| Availability ("short-dated only") | text | Stock expiring inside the return window. | shown as a price; never the recommendation | the cheapest source |
| Priced on | date | The file's date. | history, once kept | — |

## 4. NADAC (CMS weekly)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| NADAC per unit | micros | The national average acquisition cost per unit for this NDC, effective on a date. | the reimbursement benchmark; the floor's ingredient part; the NADAC-payer's expected paid; the gap the buy list ranks by | **the cost side of any margin** (it is what other pharmacies paid, not this one) |
| Effective date | date | From when it applies. | picking the NADAC in force on the fill date | pricing a July claim against today's file |
| Description, classification, pricing unit, OTC | | CMS's product description and flags. | the product key; brand/generic; unit match | grouping across a brand/generic line or a unit mismatch |

## 5. Rebates and the ratio (McKesson statement, ladders, drill-down)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Tier rate (from the ladder at the band) | fraction | What a contract generic earns back at this month's band. | `effectiveMicros = gross × (1 − rate)` on lines marked rebated, **once** | applying to unmarked lines; applying to another supplier; applying again anywhere downstream (every "effective" figure already has it) |
| Scrubbed GCR (statement) | percent | Generic Rx ÷ (Total Rx − McKesson's exclusions). **Selects the band.** | band selection; restating the daily figure | — |
| GCR (drill-down) | percent | The same ratio with only the exclusions the report was scheduled with (flu, drop-ship). | trend; projection base; restated to the statement's basis as an estimate | selecting the band as it stands (bottom band instead of top on this pharmacy) |
| OS/Rx, OS/Gx | percent | OneStop share of total Rx; of total generic. | the GPR ladder's measure (OS/Gx); a check on the reader | the generic compliance band |
| One Stop ($) | cents | The month's contract-generic purchases. | the **base** the band rate is paid on | the numerator of the GCR (that is all generics) |
| Band delta / band at risk | cents | Rebate at one band less at another, on the base. | the order-level second price, shown beside a line | adding into a line's effective cost (that would count the rebate twice) |

## 6. Claims-derived learning

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Pay basis per plan | class | NADAC-tracking, flat per product, unknown; from ≥10 claims and the direct NDC test. | which NDC pays more for this plan | pricing a plan called "unknown" (its units are left out and the share is reported) |
| Ratio to NADAC per plan | fraction | Median paid ÷ NADAC for a NADAC-tracking plan. | expected paid = NADAC × ratio | a flat plan |
| Units per plan per product | units | From live claim rows, once per fill. | weighting the NDC choice | — |
| Span of claims held | days | First to last fill date. | scaling any "over the claims held" figure to a month | assuming the claims are a month |

## 7. Recommendations

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Amount, cadence | cents; monthly or one-off | What acting is worth. | ranking by a year's worth | mixing cadences; scaling by confidence |
| Confidence | word | How sure, from the scrub or the rate on file. | shown | scaling the amount |
| Overlaps with | keys | Rows describing the same problem. | counting a problem once in the total | — |
| Outcome | cents | What the claims showed after the advice. | the scorecard | inventing when "too early" |
| Price move | micros per unit, two dates | The cheapest effective source's last two prices (`price-moves.ts`). | a rise costed on units a day × 30 | a standing gap (that is the buy list) |
| Under cost | cents a month | NADAC newly below the cheapest cost, on the units paid at NADAC. | switch, stop or appeal | every unit once the plans are classified |
| Receivable on account | cents | Patient total billed to an account on AR rows. | "earned, not money yet" beside the P&L | the plan remit on another leg (that is the remittance reconciliation) |

## 8. The double-application traps, named

1. **The rebate.** It comes off once, in `effectiveMicros`, on lines a document marks. Every
   downstream figure called "effective" already has it. The band value is a separate,
   order-level figure and is never added to a line.
2. **The coordinated fill.** One bottle, two rows. Cost and quantity are on the dispensing row
   only; revenue is the sum of live rows' Amounts; the patient's share is the sum of live rows'
   Totals, flagged when two rows both carry one. The primary's Copay is never revenue.
3. **The estimate inside gross profit.** PioneerRx's printed GrossProfit contains its own
   estimated rebate and DIR. It reconciles the file; it is not the site's margin.
4. **Package against unit.** An invoice prices a package, a catalogue and NADAC price a unit.
   Nothing compares until the pack size converts it, and a missing pack size excludes the row.
5. **The benchmark as a cost.** NADAC is the reimbursement side, never the cost side.
6. **The daily ratio as the band.** The drill-down's GCR carries only the report's exclusions;
   the statement's scrubbed figure selects the band.
7. **The claims held as a month.** A saving over all claims held is scaled by the span of days,
   and is not "recurring" under a week.
8. **A BIN as a plan.** A BIN is a route; BIN and group is a plan; contract id names the agreement.
9. **A blank rebate column as "no".** IPD and IPC print the column empty: unknown, not not-rebated.
10. **Reversals that match nothing.** Stored as reversed and unmatched; excluded from fills; never
    a loss.
11. **One dollar in two "not yet money" buckets.** A coordinated fill's plan remit is awaited under
    the remittance reconciliation; only the AR leg's patient total is on account. Never both.
12. **A standing position as a move.** The buy list says where a product stands; a price-move row
    is a transition between two dated points. The same NDC on both is marked `overlapsWith`.
