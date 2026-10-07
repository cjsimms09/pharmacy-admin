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
| Rx-fill, BIN, PCN, Group, Ntw Reim. Id | | Identity of the prescription and the payer route. | the fill key (rx, fill, date, NDC); the plan key (BIN, PCN, group); links to contract | a BIN alone as a plan (one BIN carries many plans); a BIN and group alone (one BIN and group carries a commercial PCN and a Part D one) |
| Cash plan (BIN 028249, "PharmD") | flag | The pharmacy's own cash programme. | margin and cash pricing | floor review, appeals, payer ranking (there is no payer) |
| Transaction key | | rx, fill, status, date, BIN, NDC, remit, copay, qty, plus an ordinal for identical rows. | de-duplication across re-sent days | matching a reversal (that is by negated figures, not by key) |
| Network reimbursement id (545-2F) | text | The PBM's name for the network contract the claim priced under. | matching a claim to its rate exhibit; splitting a PBM's plans by contract | a PBM name; a plan id |
| PCN | text | Processor control number: with the BIN, which processor and often which line of business. | plan identity (BIN, PCN, group); contract matching | dropped from the plan key |

## 2. Invoices (supplier PDFs, read to lines)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Unit cost (`unitCostCents`) | cents **per package** | What the invoice charged for one package as it prices it. | the pharmacy's paid price, once converted per unit | comparing with a catalogue or NADAC before dividing by the pack size |
| Pack size (`packQty`) | units | Units in the package the invoice prices, from the catalogue. | converting invoice price to per unit | guessing when absent: the row is excluded and says so |
| Extended, and the invoice's printed total | cents | The line and the whole. | the reconciliation that decides whether lines are stored at all | — |
| Rebated flag (McKesson's K) | flag | The line earns the OneStop generic rebate. A flag beginning K says so; no flag says it does not; any other letter is a flag the site does not know and is stored as *not stated* (pitfall 15). | taking the tier rate off **this line's** price | inferring from the product; only a document says it; reading *not stated* as *not rebated* |
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
13. **One payer fee in three records.** A fee a payer takes from a remittance is printed on the EFT's payment report (its
    AH and CS rows), on the 835 (a provider-level segment) and in the reconciliation service's adjustment report. It comes
    off revenue once, from the best record of that remittance, on the accrual account only (section 9); proved in tests/payer-fees.test.ts.
    A person's word on one line (count it, leave it out, undo that) is kept across every import, and is the only way a held line
    (a credit, an unsettled code) enters the figure.
14. **Tied to no claim read as not counted.** A payment's claim tie says which claim it settled; whether its fill's revenue
    includes it is decided separately, by prescription, fill number and date, with reversed claims skipped (`groupIntoFills`).
    So "tied to no claim" is not "in no fill's revenue", and the phrase for the other is "tied to a claim", never "counted".
    Say the cause (section 10), never "unmatched" or "missing": most payments tied to no claim are for fills from before the
    claims feed that the site holds no claim for, and need nothing, and a bare count of them reads as a backlog.
15. **A flag letter the reader does not know.** McKesson prints a letter after a line's price: one beginning K puts the line on
    the rebate contract. Another letter (a V on 6 October 2026) is a flag the site does not know. The line is still read, because
    its quantity times its price is its extended amount, and its rebate status is stored as *not stated*, neither on contract nor
    off. The cost ledger prices it at its printed price, the basket-share reader counts it in neither basket, and the contract
    replay counts only K lines. Dropping the line, as the reader did, made the invoice short and left its cost out of the ledger.

## 9. What a payer takes off a remittance (EFT payment report, 835 provider-level segments, adjustment report)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Payer fee: an origination fee (AH), or a recoupment (CS) where the payer took money | cents | Money a payer kept from a remittance after the sale. Not the point-of-sale concessions, which are inside the paid amounts. | an offset to revenue on the **accrual** account, in the remittance's month, **once**, from one record of that remittance: the payment report, else the 835, else the adjustment report | the cash account (a deposit is net of it already); a second record of the same remittance; a balance forward; a credit |
| Balance forward (code FB, or a reference reading "balance forward") | cents | A negative balance the payer carries to a later remittance. No money moves that day. | a note on the month | revenue, a fee or a recovery, on either account |
| Credit (CS where the payer gave money back) | cents | Money returned for something the report does not itemise. | a note on the month; held until its meaning is settled | netting against fees |
| Any other provider-level code | cents | Meaning not settled. | held on neither account and said on the month | either account until the owner says what it is |
| The sign | — | An 835 provider-level amount in `remittance_holdbacks.amount_cents` is positive where the payer took money; the adjustment report's amount is negative where the payer took money. | converted once, in `payer-fees-store.ts` | comparing the two records without converting |
| A person's word on a fee line | — | "Count it", "leave it out" or "undo", from the Money page's "Payer fees on remittances" card, on one line of an 835 or the adjustment report. Written as an audit event (`payer_fee.counted`, `payer_fee.left_out`, `payer_fee.reopened`) keyed on remittance, code and amount (`feeKey` in `payer-fees.ts`), so it survives every import and a better record of the same line arriving. The latest word under any spelling of the remittance stands. A line a better record already counts, and a balance forward, take none. | which 835 and adjustment-report lines `payerFeesByMonth()` counts; the card's presses | the payment report's own AH and CS rows (they are expenses in their own right); a line with no date in any month's figure (it is shown in every period and moves none) |

## 10. Payments tied to no claim, and why (`untied-payments.ts`, read through `untied-payments-store.ts`)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Payment in the books | count, cents | A `claim_payments` row with `out_of_books` false: received on or after 1 September 2026. The boundary is the date it was RECEIVED, not the fill date (`books-start.ts`; a fill-date exception was tried on 15 September and withdrawn). | the cash account; the total the payments page starts from | a receivable: a payment received since 1 September for a fill from before the claims feed is real money in the books and is owed by no one |
| Payment tied to a claim | count, cents | `claim_id` set: the matcher found the one claim the payment settles (`findClaim`: the strictest level of prescription, fill and drug that finds any, then the voucher a programme pays, then the BIN, then the exact amount the claim was paid). | a claim's paid-so-far; a payer's received figure on the owed pages | "counted in the fill's revenue": that is decided by `groupIntoFills`, by prescription, fill number and date, with reversed claims skipped |
| Payment tied by hand | count, cents | `claim_payments.tied_by` set (migration 0141): a payment that fits two or more claims equally (`fits_several`), tied to the one claim the owner pressed "This is the claim it paid" on, on the Payments page (`tieByHand`). His name stays on it, the sweep that revisits tied payments leaves it where he put it, and the same money arriving again by another report is read as this payment. "Take it back" on the same page (`untieByHand`) ties it to no claim again. It is refused for every other cause. | the Payments page's "Attached by hand" card; a claim's paid-so-far, like any tied payment | counting it as something the matcher found: it is his word, and the only tie made by a person |
| Remit-to-claim proof, one month | count, cents, by place | Every payment received in the month, each in exactly one place: tied to a claim, whatever the fill date; tied to none and judged by the Payments page's causes; or tied to none for a fill from before the books that the site holds no claim for, which is cash and is counted apart (`remitToClaim`, `judgeRemitToClaim` in `engine/proofs.ts`). The three add up to the payments table's own count and sum for the month. It passes when every judged payment is tied or is one the page says needs nothing; it fails, saying which and how much, when any needs a decision, a look, or the next claims load. A month nothing came in for is measured and none. | the nightly proof and its "needs you" line, which links to the Payments page | saying a month's money is settled while the Payments page still asks about a payment of it; "the payer paid nothing" |
| Payment tied to no claim | count, cents (signed: money a payer took back is negative) | `claim_id` null, in the books. Never given without its cause, below. | the payments page (`/claims/no-claim`), the Claims card, the alerts and the owed and AR pages' sentence about them | "unmatched", "missing", "not counted", "in no fill's revenue", or a to-do count |
| Cause | one of nine | Why the payment ties to no claim, from the matcher's own verdict on the claims the site holds for its prescription (`verdictOnPrescription`), listed from the ones that need a person: `fits_several` (two or more paid claims fit it equally), `reversed_sold` (its fill's claims are reversed and one carries a sale date), `no_claim_yet` (no claim for the prescription on file), `other_fills_only` (claims for other fills, none for this one), `not_a_fill` (names no drug and no fill), `will_attach` (its claim is on file now; the next re-match attaches it), `reversed_not_sold` (its fill's claims are reversed and none carries a sale date), `cancels_out` (a payment and a take-back of exactly its amount for the same prescription, fill, fill date and drug, from the same payer by the same kind of remittance: together they move no balance), `before_feed` (below). | what any screen, alert or report says about such a payment | a second classifier: every surface reads `untied-payments.ts`, and a new surface reads it too |
| What a cause asks of a person | decide, look, wait, nothing | Decide: `fits_several`, `reversed_sold`. Look: `no_claim_yet`, `other_fills_only`, `not_a_fill`. Wait: `will_attach`. Nothing: `reversed_not_sold`, `cancels_out`, `before_feed`. | which payments go on a to-do list; the headline | counting the "nothing" ones as work |
| For a fill from before the claims feed (`before_feed`) | count, cents, by who paid | The site holds no claim for this fill (none for the prescription, or claims for its other fills only) and the fill date is present and before the day the claims feed begins. Never decided by date alone: a claim for such a fill can arrive in a later report, and then the payment is judged like any other. | a count by payer, apart from the list, and the sentence "the site holds no claim for" them | a receivable, an alert or a task: he does not want alerts for claims from before 1 September |
| The day the claims feed begins | date | The earliest day any claims import covers (`claim_imports.period_from`, `claimsFeedStartsOn()`). | deciding `before_feed` | the books boundary (`SITE_STARTS_ON`): the two are the same day now and are different things |
| Nothing has arrived (owed pages) | yes or no | Every payer line has no payment tied to its claims (`nothingHasArrived` in `payer-owed.ts`). | the owed page's headline | "the payer has paid nothing": payments tied to no claim are in no payer's balance and are said beside it (`unattachedSays`) |

## 11. What stands for a remittance at the bank (`engine/remit-standing.ts` and `engine/remit-sweep.ts`, read by the morning check)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Remittance with a payment number | count, cents | A row of the remittance register (`remittance_register`) whose payment number is not blank and whose advice date is on or after 1 September 2026 or not captured (read by `daily-check-store.ts`): the payer saying that a deposit under that number has been made. It is banked when a receipt the books count carries that number (`payment number`), when ProviderPay's account history shows its deposit reaching a bank line (`sweep deposit`), or when a receipt is keyed to its remittance number (`remittance number`); the same amount near the advice date is not enough for it, because two remittances of one amount are two deposits. The date that decides is the advice date, not the day the cash arrived. An advice of $0.00 or less (a payer's payments and take-backs netting to nothing, or a negative net) is money taken back and not money sent, so no bank line could stand for it: it is left out of every count and list and said apart. | the morning check's line "money the payer says it has sent has reached the cash account", whose "of N" is this population | the books boundary for a payment (that is the day it was RECEIVED, `books-start.ts`); "paid and not banked", or "no cash is owed", for a row with no number: a cheque payer's never gets one and is banked at the counter |
| What stands for a remittance | `payment number`, `sweep deposit`, `remittance number`, `amount in window`, or none | The receipt that stands for the remittance and the strongest evidence for it, each receipt used once, the oldest advice first, except that the account history is asked first: a remittance it proves takes its receipt before any other's weaker claim can (the one carrying its payment number where there is one), so that a receipt is never counted for two remittances. The morning check asks over the receipts the books count (`booksOnly`); the bank matcher and the Remits tab over all of them. `payment number`: a receipt's reference carries the number (six or more digits). `sweep deposit`: ProviderPay's account history on file holds the number on exactly one deposit, of the remittance's own amount, in a sweep whose deposits add up to its transfer, and that transfer equals, to the cent, a bank line the bank names as ProviderPay's own, placed as payer money, dated 0 to 3 days after the sweep (each line and each sweep used once). `remittance number`: a receipt's key names the remittance. `amount in window`: a receipt of the same amount within 14 days of the advice, the weakest, a guess at which receipt. | the bank page's offer list (a remittance something stands for is not offered again), the Remits tab and the morning check | proof that this remittance and not another of the same amount was banked, where the evidence is `amount in window`; the receipt label the bank matcher gives a deposit when two advices share its amount (it takes the nearer date, and says it is a guess) |
| What the account histories can say of a remittance nothing stands for | `none`, `ends too soon`, `has a gap`, `reaches past`, `holds a deposit` | `none`: no account history is on file. `holds a deposit`: it holds a deposit under the number that is not shown reaching a bank line already placed (asked before the rest, because a deposit is a deposit wherever the file ends). `ends too soon`: the newest on file ends before the advice date plus 14 days, too soon to show its deposit either way. `has a gap`: the newest on file reaches past that, but no file on file has a dated line in the advice's month or in the month the fortnight ends in, so it cannot show the deposit either way: the newest day is a high-water mark and says nothing of the months below it. `reaches past`: it reaches past that, covers those months, and holds no deposit under the number. An advice with no date is said by what the history holds, since it cannot be said to end too soon after nothing. `historyReachOf` in `engine/remit-sweep.ts`; the sentences are `historySaid` in `daily-check.ts`. | the sentence the morning check says of that remittance: `ends too soon` and `has a gap` are not yet known (the second is a file to pull, or one too large or unreadable to have been opened), `reaches past` is a measurement with nothing found, `holds a deposit` is a bank line to place | one word for all five ("missing", "not banked", "not paid") |
| The day the export was read | date | The day the register's newest row was last seen (`max(last_seen_at)`, on the computer's own clock: the code names no zone), as against the newest advice date the register holds. The ProviderPay pull is monthly and by hand, so the two are different days. | said beside the verdict, so a quiet month is not read as a clean one | the age of the data: the newest advice is an earlier day than the read |

## 12. What he has said of the morning check (`check-marks.ts`, `daily-check.ts`, shown on Today)

| Figure | Unit | Meaning | Use for | Never for |
|---|---|---|---|---|
| Wrong alarms | count of presses, in all and in the last 30 days | Every "This is wrong" press ever made on a line of the morning check, kept for good: a press that is later put back, replaced or ended still counts. Pressing the same button again on the same finding while the first press still stands is not a second press (the table refuses it), so a double click is not counted twice; pressing again after it was put back, or after the other button in between, is a new press. The last-30-days figure goes by the press's own time stamp. If the count cannot be read the card says it is not measured because that record could not be read, and if the morning check did not run it says that instead; never none. | the count of times he told the morning-check card that one of its lines was wrong, which is the nearest measure the site has of how often it said something untrue and is smaller than that, because it covers that card's own ten checks only (an alarm on another screen, such as the Compliance banner, has no press, and nor has a wrong link beside a line) and an alarm he did not notice is not in it; said on Today as "Times you have pressed “This is wrong”" | a count of alarms (one alarm pressed, put back and pressed again is two); a count of faults in the business; judging a person; "none" when the table could not be read or was never tried |
| Findings set aside | count of failing checks | A failing check whose newest active press carries a fingerprint equal to the check's own now: he has said the line is wrong or settled, and what it found is what he saw. It is not on the card and not in `failing` (the number still open); the night's stored line still counts it as failing and says "(n set aside)", and it is listed under "findings set aside" with a Put back button. | a line that need not ask for his attention again until something changes | a check that now passes (its press ends as `passed`); a check whose findings changed (its press ends as `changed` and the line shows again); a check that could not run, which cannot be set aside |
| Fingerprint of a finding | text | What the check found, not what it compared the finding with: the offenders and where each stands, or the surplus (rows over their deliveries, records over their files), joined by a separator. The totals it was read against, the evidence counts, the horizon and the days a source reaches are left out on purpose, so an ordinary delivery or import does not end a press. A clock enters only where the finding is worse for time passing: whole days since the mailbox sweep, and the rebate statement's age in 30-day steps, so a press on either lapses on the next whole day or the next multiple of 30 days of age, not 24 hours or 30 days after the press. An error text is never stored, only a short hash of it with its digit runs taken out, because an error can carry an address. Two readings with equal fingerprints are the same finding as far as the check can tell. | deciding whether a press still covers the finding on the screen | deciding whether a finding is true; anything outside `sortMarks` and `markShown`; telling two offenders apart where a check prints only a number (`inbox-rows`, `invoice-documents`, `booked-no-document` and `doubled-ladders` print one bare number, and `offsets-dated-paid` and `payments-counted-twice` a count and a dollar total), where a swap of one offender for another, or one cleared while another appears, reads as the same finding |
| How a press ended | `passed`, `changed`, `replaced` or `put back` | The check came right; what it found changed; a later press on the same check (the other button, or the same button on what the line says now) took its place; or he took it off himself. A press with no end is active. | saying why a line came back, or went | treating a press with an end as having been undone: every press stays on file |
| Wrong alarms not yet answered | count | "Wrong" presses with no answer written (`answered_at` empty), oldest first, whether or not the press still sets its line aside. | what a session reads before it builds anything new (`scripts/wrong-alarms.ts`); an answer says what was done, or the question put to him | a "settled" press, which is his and is never answered; closing one without saying what was done |
