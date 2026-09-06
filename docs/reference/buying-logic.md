# Buying logic: what to order, from whom, and why it makes money

This is the reasoning the purchasing pages rest on, written down so it can be checked against
real figures and argued with. Every rule here is either in a pure module with tests or is named as
missing. Nothing in it is a number the software made up.

## The objective

For each product the pharmacy dispenses, choose the NDC and the supplier that maximise

    expected margin per unit  =  expected reimbursement per unit
                              −  effective cost per unit
                              −  expected loss on stock that does not sell

summed over the units the pharmacy will actually dispense, and then, across the whole order,
adjust for what the order does to the rebate band. "Cheapest" is one input. It is not the answer.

## The four sides, and where each comes from

| Side | Source held today | Module |
|---|---|---|
| **What it costs** | invoice lines (paid), supplier catalogues (offered), rebate ladders and today's scrubbed ratio (the tier off a rebated line) | `product-ledger.ts` (`effectiveMicros`), `rebate-rates.ts`, `purchase-ratio.ts` |
| **What it pays** | daily transaction report (ingredient paid, plan, NDC, quantity), NADAC in force on the fill date, the plan register (whether SB 20 reaches the plan) | `pay-basis.ts`, `reimbursement-rules.ts`, `plans.ts` |
| **Which NDCs are the same product** | NADAC's description, brand/generic flag, pricing unit, OTC | `product-groups.ts` |
| **What the order does to the band** | the ratio ladder, the month-to-date position from the daily drill down (checked against itself), the order's lines by kind | `drill-down.ts`, `ratio-effect.ts` |
| **What unsold stock costs** | return policy per supplier, invoice date, claims since | `returns-due.ts` |

## Rule 1: reimbursement depends on who is paying, and the claims say how

The same product dispensed to two plans is paid two ways. A plan pricing off NADAC (Medicaid; any
plan the Kansas floor reaches from 1 July 2026; some commercial contracts) pays each NDC by that
NDC's own NADAC. A plan on a MAC schedule pays every NDC of the product the same. So which NDC
"pays the most" has no answer until the payer is known.

The transaction report carries no basis-of-reimbursement field, so `pay-basis.ts` reads it off the
money, per plan:

1. *Cluster*: ingredient paid ÷ (NADAC × quantity) for every paid claim. NADAC-based plans cluster
   tightly around one ratio; MAC plans scatter.
2. *Direct test*: where the plan paid on two NDCs of one product with NADACs at least 10% apart,
   did it pay them differently and in NADAC order (tracks) or the same (flat)? This outranks the
   cluster.
3. Fewer than ten claims, or products that disagree: **unknown**, and unknown units are left out
   of every comparison downstream rather than guessed.

The statutory floor is separate and not empirical: a plan the register says SB 20 reaches pays at
least NADAC + fee on every fill after 1 July 2026, and is scored as `basis: "floor"` regardless of
what its history shows.

**Live check wanted:** run `payBasisByPlan` over the claims held and look at the top ten plans by
claim count. The expected shape: Kansas Medicaid tracks NADAC at about 1.00; Part D plans mostly
flat; commercial mixed. Anything surprising is either a data problem (unit mismatch, NADAC gap) or
a finding.

## Rule 1a: back-calculating the plan's formula

`reimbursement-fit.ts`. The report gives the ingredient cost paid on every fill and the site
holds NADAC for the day and AWP off McKesson's invoices. A contract prices the ingredient one of
three ways, and each leaves a signature across many fills that a guess does not:

    NADAC + k%        paid ÷ (NADAC × qty) is one constant
    AWP − d%          paid ÷ (AWP × qty) is one constant
    a MAC per product paid per unit is one constant per product, whatever the NDC

Brand and generic are fitted apart. The formula with the least scatter is named with its scatter
("brand: AWP − 17.4%, ±1.2 points, on 212 fills"); two within a point of each other is "not
settled"; under twelve fills with a benchmark nothing is said. The residuals name the fills the
formula does not explain, which is where underpayments and DIR hide. A fit is the plan's
behaviour measured, never its contract: the contract on file is what an appeal cites.

**AWP.** The site holds AWP only where McKesson's invoice printed it. The weekly PioneerRx
catalogue export carries no AWP (its columns are item number, name, NDC, pack size, cost per
unit). PioneerRx itself licenses a drug file with AWP: the cheapest broad source is a scheduled
PioneerRx item report (NDC, AWP, WAC, package size) emailed weekly, and "Dispensed AWP" added as a
column to the daily transaction report, which the claims export already knows how to read. No
free public source publishes AWP; it is Medi-Span's and First Databank's.

## Rule 2: within a product, score every NDC against the plan mix

`ndc-choice.ts`. For one product, every NDC with a comparable per-unit cost is scored against the
units dispensed to each plan over the period:

- floor / NADAC-tracking plan → pays NADAC(NDC) × the plan's ratio
- flat plan → pays what it has paid per unit of the product, whichever NDC
- unknown → not priced; the share of units that could be priced is reported

The recommendation is the NDC with the highest margin per priced unit, and only when at least
80% of the units could be priced, the gain over what is bought today clears the materiality line,
and the current NDC could itself be priced. Otherwise **cannot say**, with the reason.

The direction of the errors is chosen: an NDC with no pack size is not scored (a package compared
with a unit invented a ninety-nine-thousand-dollar saving once); a short-dated price is never the
recommendation; the rebate comes off the cost once, in `effectiveMicros`, and the band effect is
shown beside the choice rather than added into it.

## Rule 2a: the buy list — furthest under NADAC after the rebate, not cheapest

`under-nadac.ts` is the list the buyer asked for. For every NDC the site can price — every
invoice line and every catalogue line, at every supplier — it takes the cheapest source that is
not short-dated, with the rebate already off (`Buy.effectiveUnitMicros`), and measures the gap
to NADAC per unit. The list is ordered by that gap and by what the gap is worth on the units
actually dispensed. Within a product the NDC with the widest gap is the pick, and the gain is
measured over the NDC dispensed most today, on the product's own volume. Three views:

- **the rows**: every usable NDC, widest gap first, with the supplier to buy it from;
- **switch NDC**: products where a different NDC than the one dispensed today clears the
  materiality line — "buy B from McKesson instead of A: $80 more on 1,000 units";
- **not yet bought**: NDCs offered well under NADAC that the pharmacy neither buys nor dispenses.

Refused with the reason, never dropped: no NADAC, no per-unit price, only short-dated stock. A
rebated line with no rate on file is compared gross and says so; that understates the gap, which
is the safe direction. This is the NADAC-payer answer; Rule 2 (`ndc-choice.ts`) refines a
product's pick by what each plan actually pays, once the claims have shown it.

The rebate rate in every figure here comes from `rebate-rates.ts`, and so from whichever ratio
selected the band. Rule 3 says why that ratio must be the statement's until the drill-down
carries McKesson's own exclusions.

## Rule 3: every McKesson line has a second price, and the ratio is the generic share

McKesson's daily Purchase Drill Down prints three ratios with the money under each, and the money
settles what they are (checked to the cent on six months of the pharmacy's report, `drill-down.ts`):

    GCR    = generic Rx purchases (excluding MPB) ÷ (total Rx purchases − exclusions)
    OS/Rx  = OneStop purchases ÷ total Rx purchases
    OS/Gx  = OneStop purchases ÷ total generic purchases

So the **generic compliance ratio is the generic share of what is bought at McKesson**. Every
generic bought there lifts it, contract or not; every brand bought there drags it; and OneStop
does not enter into it. OneStop is what the band's rate is *paid on*, and what the second ladder
(GPR) is measured by as OS/Gx. Two levers, then: the generic share picks the rate, the OneStop
purchases are the base.

`ratio-effect.ts` projects where an order leaves the ratio and what the band is worth:

- the next band: how many dollars of generics at McKesson reach it, and what the band is worth
  on the OneStop base;
- the headroom: how much brand can go through McKesson before the current band is lost;
- per line: "buying this brand here lowers the ratio 0.09 points and loses the 24% band, which
  is $336 on the month's contract generics"; "buying this generic at IPC instead lowers it 0.02
  points and the band holds".

**The scrub, and the one thing the site must not do.** The drill-down's exclusions are whatever
the report was scheduled with; the pharmacy's says "GCR Denominator Exclusions is Flu or
Dropship". The rebate statement's *scrubbed* GCR applies McKesson's own list, which is wider
(GLP-1s among them): May was 10.13% on the drill-down and 20.64% on the statement. The band is
selected by the statement's figure. A site that selects the band from the drill-down as it is
scheduled today puts the pharmacy in the bottom band while McKesson pays it at the top, and then
tells the buyer every contract generic costs fourteen points more than it does. So:

1. The scheduled report should be set up with the same exclusions McKesson's scrub uses, if the
   filter offers them. Then the daily figure *is* the scrubbed one and can select the band.
2. Until it is, the daily figure is a trend and a projection base, not a band selector. The band
   comes from the last statement, and `withScrub` restates the daily position to the statement's
   basis from a same-month pair, labelled as an estimate.
3. Either way the reading is refused when the money does not reproduce the printed ratios
   (`checkMonth`), the way the statement is refused in `rebate-report.ts`.

## Rule 3a: the McKesson question — where to draw the line

`band-strategy.ts`. Generics are often dearer at McKesson and lift the ratio; brands are cheaper
there and drag it. The answer is two rules, and the second is decided fresh each month:

1. **Line by line, buy where the effective cost is lowest.** Effective means after the rebate that
   line itself earns: a OneStop generic at the band rate, a McKesson brand at the brand factor,
   anything elsewhere at its gross. This is not "ignoring the rebate game"; the rebate is part of
   each line's price and the ledger already compares on it. A McKesson generic that is dearer
   gross and cheaper effective is bought at McKesson; a brand that is cheaper at McKesson is
   bought at McKesson.
2. **Once a month, cross a band only when what it pays exceeds what it costs to get there.** The
   band is a step. Two levers move the ratio: brand off McKesson (the denominator shrinks) and
   generic on to McKesson (both sides grow). Each has a price per dollar moved (the secondary's
   brand premium plus the brand factor forgone; McKesson's effective generic premium over the
   secondary) and a supply (what can actually move this month, unscrubbed brands only). The
   module works out the cheapest path to each band above, its cost, and the band's worth on the
   month's OneStop base:

       move only if  (rate_next − rate_now) × base  >  cost of the cheapest way there

   and, the other way, how much brand can still go through McKesson before the current band is
   lost. Where nothing pays, Rule 1 stands alone and the ratio lands where it lands.

So the mixture is not a fixed share. On this pharmacy's own figures it will usually be: Rule 1
for everything, plus a small, specific move at month end when a band is within reach and the
move is cheaper than the band is worth. The module says which move, how much, and the net.

## Rule 4: what does not sell is a cost, and the return policy prices it

A unit bought and not dispensed inside the supplier's full-credit window is worth the credit
percentage of what was paid, less any restocking fee, and nothing at all after the window closes.
`returns-due.ts` already counts this down from the invoice date. What is not yet done is to put
it on the buying side: expected loss per unit ordered = P(unsold inside the window) × (1 − credit
fraction), with P from the product's dispensing rate in the claims against the order quantity.
This needs an on-hand quantity to be honest, which no feed carries yet. Until it does, the buying
comparison shows the dispensing rate and the supplier's window and leaves the judgement to the
buyer, rather than inventing a probability.

## How the rules combine at the order screen (not built yet)

For each line the buyer is about to order:

1. Product group → candidate NDCs (Rule 2) → the NDC that pays the most on this pharmacy's mix,
   with the gain and the share of units that could be priced.
2. For that NDC, the supplier with the lowest effective cost (`product-ledger.ts`), rebate off
   where a document says it applies.
3. The ratio effect of buying it there rather than at McKesson (Rule 3): safe this month, or not.
4. The days of supply the quantity represents at the dispensing rate, beside the return window.

Nothing is submitted anywhere. The output is a sheet with a sentence per line and every figure
traceable to a document.

## What is missing, in order of value

1. **On-hand quantity** (a scheduled PioneerRx inventory report). Without it, days of supply and
   the return-risk term are guesses, and "what to send back" can only count from the invoice.
2. **Basis of reimbursement on the claim** (NCPDP 522-FM) if PioneerRx can add it to the daily
   report. It would replace the empirical reading of Rule 1 with the plan's own statement.
3. **A product reference beyond NADAC's description** (Orange Book or RxNorm) to widen groups
   safely. Today's key errs towards too many groups, which loses comparisons but never merges
   products that cannot be substituted.
4. **The rebate ladders of IPD and IPC**, and their eligibility rule, entered on the terms page.
   Their catalogues carry a rebate column that is blank, so eligibility there has to come from the
   agreement.

## Tests that keep this honest

Each module's tests use round figures that can be checked by hand: `tests/pay-basis.test.ts`,
`tests/ndc-choice.test.ts`, `tests/ratio-effect.test.ts`, `tests/product-groups.test.ts`,
`tests/drill-down.test.ts`, `tests/under-nadac.test.ts`, `tests/reimbursement-fit.test.ts`,
`tests/band-strategy.test.ts`. When a
real statement, a real month of claims, or a real order is available on the pharmacy machine, the
right test to add is the one that takes those figures (redacted) and pins the answer the module
gives, so that the answer cannot drift.
