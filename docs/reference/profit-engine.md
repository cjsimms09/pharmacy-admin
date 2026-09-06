# The profit engine: what the site does every day to make the pharmacy more money

The end of every feed, table and page in this repository is one thing: the pharmacy keeps more of
what it earns. This document is the standing plan for that. It says what the site watches, what it
learns and where it keeps it, how its advice reaches the owner, how its advice is judged, and what
is audited on what schedule. When a page or a module is added, it should be possible to say which
line below it serves.

## 1. The loop

Every morning, in this order:

1. **Take in** what arrived overnight and refuse what does not reconcile (the readers; every one
   checked by arithmetic before anything is stored).
2. **Update what the site knows** about this pharmacy (§3): plan pay bases from the new claims,
   the ratio position from the drill-down, prices from the catalogues, costs from the invoices.
3. **Look** across every variable in §2 for money: a better NDC, a supplier to switch, a band about
   to be lost or within reach, a bottle to send back, a claim paid under the floor, a plan paying
   under cost.
4. **Say it** on one page, ranked by dollars a year, each line an amount and an instruction (§4).
5. **Remember** what was said, and **score** what was said before against what the claims show
   happened (§5).

Weekly: price history and NADAC moves (what got dearer, what the benchmark dropped under cost).
Monthly: the rebate statement against the site's own projection; the scorecard.

## 2. The variables it watches

For every product the pharmacy dispenses or could buy, all of these, and the answer is always
the combination, never one of them alone:

| Variable | Source | Module |
|---|---|---|
| Cost per unit, per supplier, gross and after the rebate the supplier really pays | invoices, catalogues, ladders, ratio | `product-ledger.ts`, `rebate-rates.ts` |
| NADAC per unit, in force on the day | CMS weekly | `nadac.ts`, `reimbursement-rules.ts` |
| What each plan actually pays per unit, and whether it follows NADAC or a schedule | claims | `pay-basis.ts`, `payer-map.ts` |
| Units dispensed, by plan, by NDC, and the fill's true revenue however many payers priced it | claims | `fills.ts` |
| Which NDCs are the same product | NADAC's description | `product-key.ts`, `product-groups.ts` |
| The generic share at McKesson this month, the band it selects, what the next band is worth | drill-down, statement, ladder | `drill-down.ts`, `ratio-effect.ts`, `rebate-view.ts` |
| Days since each invoice against each supplier's credit steps | invoices, return policies | `returns-due.ts` |
| Claims paid under the Kansas floor, and under cost on plans the floor cannot reach | claims, NADAC, plan register | `floor-review.ts`, `against-nadac.ts` |
| Money that arrived after the claim: facilitator, secondary, top-off | 835s, credit memos | `claim-payments.ts` |
| Returns to stock: transmitted and reversed without a sale | claims | (§6, to build) |
| Price movement week on week, catalogue and NADAC | catalogues, NADAC | (§6, needs price history) |

## 3. What the site learns about this pharmacy, and where it keeps it

Learning here means a fact the site did not have on day one and now holds because the data taught
it. Each must live in a table with a date, never in a settings key, so that it can be trended and
argued with.

| What it learns | From | Held in |
|---|---|---|
| How each plan pays (NADAC-tracking, flat per product, unknown) and how confident that is | claims against NADAC | to add: `plan_pay_basis` (plan key, basis, claims, median ratio, evidence, as of) |
| Which plan and contract each BIN/PCN/group is | contracts, the owner's confirmation | `payer_links`, `plan_groups` |
| Which supplier discounts what, at what rate, this month | ladders, drill-down, statement | `supplier_rebate_programs`; to add: `rebate_statements`, `purchase_positions` |
| What every supplier charged for every NDC, every week | catalogues | to add: `supplier_price_history` |
| What the pharmacy paid for every NDC on every invoice | invoices | `invoice_lines` |
| Which NDCs are one product | NADAC | `product_key` on rows |
| What the site recommended, whether it was taken, what it came to | the money list, the owner, the claims | `recommendation_log` |
| The facts about how the pharmacy works that the manual depends on | the owner | `practice_decisions` |

The first row is the one that makes the site smarter fastest: every day of claims sharpens the
pay basis of every plan, and the NDC choice gets better without anybody typing anything.

## 4. How advice is shown

The owner should not have to open six pages. One page, `/money`, and on **Today** the three
biggest lines from it above everything else. Every line:

- **an amount**, per month or one-off, never mixed, ranked by a year's worth;
- **an instruction**, not a description: "buy B from McKesson instead of A";
- **a confidence** that is said, never used to scale the money;
- **a basis** a person can argue with, naming the documents;
- **how long it has been on the list**, and whether it was acted on last time;
- **a link** to the page where it is done.

What cannot be priced yet is listed under "money this cannot see yet", with the one fact that
would put it on the list, because a silently short list reads as good news.

Two design findings against the site today: the money page, purchasing, claims and payers are
behind the "extra sections" flag and absent from the navigation, so the profit side is reachable
only by URL; and Today's "needs you" is compliance only. Both are on the open items in
`docs/HANDOFF.md`: a **Money** group in the navigation, and the top three money lines on Today.

## 5. How advice is judged

`recommendation-log.ts` and `recommendation-store.ts`. Every row on the money list is remembered
from the morning it first appears, kept up to date while it persists, and closed when it goes.
The owner can mark a row acted or dismissed. Where the claims can measure the result they do:
for "buy this NDC instead", the share of the product's units dispensed under the named NDC since
the recommendation, and the gap realised on them, against what was promised. A scorecard adds
it up by kind of advice, so the site can say what its advice has been worth and stop repeating
what has been dismissed. This is the difference between a report and something that learns.

## 6. Next to build, in order

1. Wire §4: the buy list and the recommendations into the money page and Today; the Money group
   in the navigation. (Pharmacy session; modules ready.)
2. `plan_pay_basis` written nightly from `pay-basis.ts`, so the NDC choice reads a table, not a
   recomputation, and the trend is kept.
3. `supplier_price_history`, then price-move alerts: a catalogue price up on a daily product, a
   NADAC down under the pharmacy's cost.
4. Returns to stock as a number, by product and plan, from the reversals the feed now keeps.
5. MAC appeal packets: `against-nadac.ts` "argue" rows joined to the invoice line that proves
   acquisition cost and the PBM's appeal window.
6. Brand steering: which brands to move to a secondary this month, and what the band is worth.
7. Cash pricing against cost and NADAC + fee, now that cash fills are kept.

## 7. What is audited, and when

Each cycle, the cloud session checks and reports on the open pull request:

- **Arithmetic**: every new reader or formula on `feature/compliance` against the fixtures and
  the real files the owner has sent; any identity that fails on real rows is named with the rows.
- **Organisation**: new tables and settings against `data-audit.md`; anything stored twice or in
  a settings key that is really a time series.
- **Recommendations**: that every money row still has an amount, an instruction, a basis and a
  link; that recurring rows are scaled to a month; that nothing is counted twice.
- **Design**: that the profit side is one page and reachable, and that Today leads with money.
- **Learning**: that the log is being written and the scorecard is honest.

Findings go to the open items at the top of `docs/HANDOFF.md`, which `CLAUDE.md` makes every
session read first.
