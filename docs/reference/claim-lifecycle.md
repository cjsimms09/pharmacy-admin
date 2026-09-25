# The claim money lifecycle — the standard, and how the site measures up

**Part A: the standard.** Written by session 2 at session 1's request, 15 September 2026. September is measured
against it in part B, and part C (building) waits until session 1 has read B.

The owner asked for this:

> *"making sure we are correctly identifying which plan owes what, how much is the copay. then make sure this money is
> being follow through properly (ie copay being accounted for in cash accounting immediately but not remit amount)
> then as we get remit info, correctly attirubuting payment from either primary or secondary until entire claim is
> paid minus any fees.. this process is complicated but needs to be sound and needs to make sense"*

Each rule is written in CLAUDE.md's three lines:
- **SHOULD BE** is the standard, taken from accounting and pharmacy practice, not from the data;
- **OBSERVATION** is how the code does it today, read at `origin/feature/compliance` 244c46d, plus the claim-level AR
  and Veridikal branches where named;
- **DIFFERENCE** is what that implies.

Differences found only by reading code are marked *(read in code)*. Part B puts numbers on them. Nothing below prints
a patient, a prescription number or a real identifier.

---

## The words

| word | meaning here |
|---|---|
| **fill** | one dispensing: Rx, refill, fill date, NDC (`fills.ts` `fillKey`). One script on the count, however many payers |
| **transmission / claim row** | one payer's adjudication of the fill: one `claims` row |
| **primary / secondary** | the coordination-of-benefits position. PioneerRx's `PrimaryClaimID` is null on the first payer and points at the first payer's claim on the second (`pioneer-claims.ts` header, point 3) |
| **voucher** | a manufacturer's copay assistance applied after the plan: RedSail's switch vouchers (`EvoucherAmountPaid`) and Veridikal's (the message amount), named by `evoucher_programme` (73f7e12). **A secondary share**, the owner's rule: *"the evoucher is a secondary"* |
| **patient pay** | what the patient owes after the last payer. PioneerRx puts the whole residual on the last payer and zeroes it on the earlier ones (`pioneer-claims.ts` header) |
| **MTF share** | the Medicare Transaction Facilitator's payment of the manufacturer's refund on a negotiated-price drug, promised at adjudication (`expected_facilitator_cents`) and paid weeks later |
| **fees** | charges on a claim: a network's fee arriving as a negative remit; the PSAO's origination fee (AccessHealth AH); DIR and price concessions; a payer's recoupment (CS) |
| **settling document** | the document that says a share was paid: an 835 or AccessHealth report (plan); a RedSail voucher remittance or Veridikal summary (voucher); an MTF 835; a card batch or deposit (patient) |
| **deposit** | money reaching the bank: a payer payment report or EFT notice, a card batch, a Veridikal credit, a counter deposit |

---

## Rule 1 — Who owes what on a fill

**SHOULD BE.** Every dollar of a fill's price is owed by exactly one party, recorded once:
- **the primary plan:** its paid amount;
- **each secondary:** a COB transmission's paid amount on its own row, or a voucher, held as a secondary share owed by
  the programme that ran it;
- **the patient:** the residual after the last payer (the patient pay);
- **the MTF:** its promised refund, where the drug carries one, owed by the facilitator and not by the plan;
- **fees:** kept apart as what the pharmacy owes (a network fee), or what is withheld from a payment (PSAO, DIR,
  recoupment). A fee is never netted into another party's share.

The identity that proves nothing was counted twice or dropped:

    Σ payer shares (primary + secondaries, voucher included) + patient pay = the fill's total price

It is standard claim arithmetic, not a site convention: the payers' paid amounts and the patient's responsibility
exhaust the adjudicated price.

**OBSERVATION** (read in code):
- **Two-payer fills.** The identity is proven on September's 37, with no difference (`pioneer-claims.ts` lines
  26–37), using the remittance-pricing figures. The raw NCPDP patient field would overstate the month by $50,644.55.
- **Where the check runs.** In the PioneerRx pull (`pioneer-claims.ts` ~206–211, a cent per payer). A failing fill is
  counted in a setting (`pioneer-pull.ts` 556, 570) and nothing reads it; nothing is refused. The fill total price is
  not stored on the claims.
- **Payer position.** Not stored. The daily report reader cannot tell primary from secondary; every "Third Party"
  row is a claim (`claims.ts` 456–485). The pull knows the position and uses it only to pick a row to enrich
  (`dispensed-export.ts` 262–274).
- **Backfilled fills.** A fill the daily report never sent is written as **one** row with every payer's money summed
  into `remit_cents` (`claims-backfill.ts` 172–200). A two-payer backfill is one "payer".
- **Vouchers and DIR.**
  - The pull takes the first payer's `EvoucherAmountPaid` and `DirFeeTotal` for the fill and writes them onto **both**
    rows of a two-payer fill (`pioneer-claims.ts` 226–228; `dispensed-export.ts` 280–292).
  - 73f7e12 adds `evoucher_programme` and `evoucher_message_cents` (first non-zero across payers). No code reads them
    yet.
- **The voucher inside the remit.**
  - RedSail's voucher is inside the primary's remit: on September's voucher claims, a plan payment is remit − voucher,
    never the remit (money map section 15).
  - Veridikal's: **unmeasured**, until the next pull fills `evoucher_message_cents`.
  - Whether PioneerRx's `TotalPricePaid` includes the voucher: **unmeasured**.
- **BIN 028249.** Registered as a cash plan (`rx-transactions.ts` 174) and also used as RedSail's voucher BIN
  (`copay-remit.ts` 122). 73f7e12's reading of PioneerRx says it is RxLocal's discount card, not the voucher.
- **Negative remits.** They stay inside the fill's remit and revenue (`claims.ts` 1161–1176). On the claim-level AR
  branch they are listed apart as fees owed (money map G-AR-2).
- **The patient's share** is summed across a fill's rows (`fills.ts` 394, 447), flagged uncertain where more than
  one row carries one.

**DIFFERENCE** (read in code):
- **(a)** a fill's shares are not labelled by position, so a secondary cannot be told from a primary on
  daily-report rows;
- **(b)** backfilled two-payer fills collapse into one share;
- **(c)** a voucher or DIR copied onto both rows is counted once per row wherever it is summed. The Veridikal
  branch's receivable split does exactly that;
- **(d)** a failed identity is recorded where nobody reads it;
- **(e)** the voucher case of the identity is unproven;
- **(f)** network fees are netted into revenue and receivables (fixed for AR only, on a branch).

---

## Rule 2 — Accrual: revenue when the prescription is sold

**SHOULD BE.**
- **When.** A dispensing is revenue when the sale is complete: here, when the patient collects it (the owner's rule
  since 9 September, `sold_on`). A fill still in the bin is not yet revenue and is named, not dropped.
- **How much.** The fill's whole price: every payer share (primary, secondaries, voucher, MTF promise) plus the
  patient pay. The same money as rule 1's identity, recognised once.
- **Fees.** Revenue offsets in the month they are incurred: network fees and DIR against the fill's month where the
  claim says so, PSAO fees and recoupments in the month of the remittance that took them.
- **Later payments** add to revenue only what the claim did not already carry: a top-off beyond the promise, or a
  voucher fee.

**OBSERVATION** (read in code, `profit-and-loss.ts`):
- **Slicing and exclusions.**
  - Revenue is sliced on `soldOn` (879); unsold fills are named (886–888) ✓.
  - Fills whose cost is unknown are **dropped from revenue** too (906–908).
  - A System Sales Summary, where present, replaces the claims' remit and patient totals (307–309).
- **Later money** is added by the fill's sale month (924), labelled "Facilitator and top-off payments". It counts
  payments actually received (`revenueCents`), so an MTF promise not yet paid is not revenue.
- **Payments are found by the fill key** (`fills.ts` 536–537), not by the claim the matcher chose. A payment whose fill
  date is within ±3 days but not equal (allowed by match-remittance level 3) reaches a claim and never reaches the
  fill's revenue.
- **Fees.**
  - DIR per claim (`dir_fee_cents`) is written and read by nothing; DIR is a hand-entered offset only.
  - AH and CS are booked on the EFT's date ✓.
  - Network fees are inside revenue as negative remit, not an offset line.

**DIFFERENCE** (read in code):
- **(a)** unknown-cost fills understate revenue, which should be complete whether or not cost is known; margin is
  the thing that cannot be computed;
- **(b)** an unpaid MTF promise is missing from accrual revenue until it is paid;
- **(c)** some matched payments never reach revenue (fill key vs claim id);
- **(d)** per-claim DIR is unused;
- **(e)** network fees are not shown as offsets.

---

## Rule 3 — Cash: the copay when collected, plan money when it is deposited

**SHOULD BE.**
- **The patient's copay** is cash when the pharmacy collects it at the till: in a card batch, a cash or cheque
  deposit, or, for a charge account, when the account is paid. Never from the claim.
- **Plan, voucher and MTF money** is cash only when its deposit reaches the bank, evidenced by the payer payment
  report or EFT notice (PSAO), the Veridikal credit, the MTF credit, or the bank line. Never from the claim or the
  remittance, which say what was paid, not that it arrived.
- **Each deposit is counted once**, whichever document arrives first.

**OBSERVATION** (read in code):
- **Cash revenue** is the month's `cash_receipts` except rebates (`profit-and-loss.ts` 364–376). No claim field ever
  reaches it ✓.
- **Deposit doors.**
  - Card batches bank as "patient" on the batch date (`card-batch-store.ts` 69–80).
  - PSAO money banks from the payer payment report and EFT notice; AccessHealth reports, 835s through ProviderPay and
    MTF 835s bank nothing.
  - RedSail's voucher remittance banks its payment; Veridikal is banked from the bank line.
  - Where a month has no facilitator receipt, MTF claim payments stand in by received date (1003–1007).
- **Card batches are the till's card total**, retail and front-of-shop sales as well as copays. Their category is
  "Patient payments banked".
- **Counter cash and cheque deposits** reach the bank statement as "Deposit" lines, which stay unplaced (money map
  section 13). Nothing banks them.
- **Charge accounts.** On-account copays are noted on accrual (`profit-and-loss.ts` 357–363) and on the claims page.
  Nothing records the account being paid (`fills.ts` 611; not found elsewhere).

**DIFFERENCE** (read in code):
- **(a)** cash copays and cheques never become cash revenue unless typed;
- **(b)** a charge-account copay never becomes cash;
- **(c)** "Patient payments banked" includes retail card sales, so it is not the copay figure the owner means.
  The payment-type report (rule 5) is what separates them.

---

## Rule 4 — Settlement: each share by its own payer's document, until the claim is paid

**SHOULD BE.**
- **Who can settle what.** Each share is settled only by its own payer's document, matched to that claim:
  - the primary by the plan's 835 or AccessHealth report;
  - a COB secondary by its own 835;
  - a voucher by the RedSail voucher remittance or the Veridikal summary;
  - the MTF share by its MTF 835;
  - the patient pay by the till.
- **Matching.** A payment names its prescription, fill date and payer. The payer decides the share, never the
  amount.
- **Paid.** A claim is **PAID** when every share is settled, net of fees taken at remittance level (PSAO, recoupment)
  which are booked apart. A share paid more or less than promised is named per share (short, over, recouped) and
  never offset against another share or claim.
- **States.** Each claim carries a state: WAITING (nothing arrived), PART-PAID (some shares settled), PAID, OVERPAID.
  Age is counted from the fill date.

**OBSERVATION** (read in code):
- **Choosing a claim.** The matcher (`match-remittance.ts` 85–90) takes Rx, then fill date (exact, then ±3 days since
  ec3d22d) and NDC.
  - Where two claims on one fill fit, a unique BIN match wins, then a unique amount equal to the remit (101–118).
  - **The BIN hint is passed by the RedSail voucher and Veridikal readers only.** The 835 import, the intake
    remittance, AccessHealth, RxRescue and the orphan and re-match runs pass none (claim-payments.ts 235, 265,
    556–572; intake/actions.ts 542; accesshealth-payment-store.ts 90).
  - So a two-payer fill's plan payment is chosen by amount, or left unattached.
- **Receivables.**
  - On the claim-level branch each share is settled only by payments on its own claim and portion (G-AR-1).
  - A `copay_card` payment on a voucher claim settles the voucher share; **every other source, the MTF included,
    settles the plan's share** (`payer-owed-store.ts` 124–142).
- **Claim states.**
  - `claims.status` is only paid or reversed.
  - `claim-reconcile.ts` defines awaiting / reconciled / short_explained / unexplained / overpaid, **used only by
    tests**.
  - `remit-check.ts` compares per payer **by name**, not by claim id (66–113).
- **Remittance-level adjustments** (835 PLB: DIR, recoupments, transaction fees) are summed into a note on the
  receipt, not booked. Claim-level adjustments (CAS) are parsed and not stored (`claim-payments.ts` 504, 608–612;
  `x12-835.ts` 189).

**DIFFERENCE** (read in code):
- **(a)** on a two-payer fill a plan payment is attributed by amount, not by payer;
- **(b)** an MTF payment settles the plan's share in receivables, when the MTF share is its own;
- **(c)** no claim state is stored or shown;
- **(d)** remittance-level fees and claim adjustments are not booked, so "paid minus any fees" cannot be computed
  per claim;
- **(e)** there is no per-fill view of who owed what and which document settled it (not found: `/claims` has a
  loss-list row only).

---

## Rule 5 — The copay at the till

**SHOULD BE.**
- **Per sold day:** the copays on claims collected that day ≈ the till's prescription takings by card, cash and
  cheque. The same money seen from the claim and from the register; near, not exact, where a copay is split across
  tenders or paid on account.
- **Charge accounts:** a copay put on a charge account is a patient receivable until the account is paid, and then
  cash.
- **The till's card takings** agree with the card batch for that close.

**OBSERVATION** (read in code, `sales-by-payment-store.ts` 74–106):
- **What the payment-type check compares.**
  - The till's card net against card-batch receipts in the period, exact ✓.
  - The report's prescription remit and patient figures against **raw claim rows** with `soldOn` in the period.
- **Where that comparison is loose.**
  - Rows are not grouped into fills, and cash-plan, on-account and test-import rows are not excluded.
  - Backfilled rows carry no patient total, so they add nothing.
  - Rows the daily report loaded but the pull never enriched are missed, because it reads `soldOn`, not
    `completedAt`.
- **Card batch vs the claims' copays:** no comparison exists. Charge-account payments: no record (rule 3).
- **The payment-type report** has not been rehearsed on overlapping real data (money map G-CARD-5). Its sample
  request was declined for September (Q-SBP-1).

**DIFFERENCE** (read in code):
- **(a)** the till-to-claims check reads a different set of rows from the account's;
- **(b)** charge-account copays have no settlement;
- **(c)** unmeasured on real overlapping data.

---

## What part B measures (September, on a snapshot; counts and dollars only)

| # | measure | rule | source |
|---|---|---|---|
| B1 | fills whose shares + patient pay ≠ the fill total price; the pull's stored count of failures | 1 | claims; pull setting |
| B2 | two-payer fills: how many; how many daily-report rows carry no position; backfilled single-row fills that were two-payer | 1 | claims (`source`), pull |
| B3 | vouchers and DIR copied onto both rows: fills affected, dollars double-counted by any sum | 1, 4 | claims |
| B4 | negative remits: count, dollars, payers; how much revenue they reduce | 1, 2 | claims |
| B5 | accrual revenue dropped for unknown cost; unpaid MTF promises missing from revenue | 2 | fills, P&L |
| B6 | matched payments that do not reach their fill's revenue (fill key ≠ claim) | 2, 4 | claim_payments × fills |
| B7 | cash: counter deposits unplaced on the bank statement; charge-account copays with no settlement | 3 | bank lines, fills |
| B8 | payments on two-payer fills attached by amount, not payer; ambiguous and unattached ones | 4 | claim_payments |
| B9 | MTF payments settling a plan share in receivables | 4 | payer-owed rows |
| B10 | claims by state (WAITING / PART-PAID / PAID / OVERPAID), computed per share, and claims that look paid but are not, and the reverse | 4 | claim-level AR rows |
| B11 | shares with no expected settling document (a payer that sends no 835 or report the site reads) | 4 | payer register × readers |
| B12 | till: claims' patient pay by sold day against card batches (cards only, since cash is not banked) | 5 | fills × card batch receipts |

**For session 1, as precise PioneerRx queries** (my session cannot read PioneerRx):
- **Q-P1:** on September's fills with a voucher (`EvoucherAmountPaid` > 0, or a message amount > 0), whether
  `TotalPricePaid` = Σ `NetAmountPaid` + Σ `PatientPayAmount`, and whether the primary's `NetAmountPaid` includes the
  voucher. Counts and dollar totals by programme only.
- **Q-P2:** on September's 37 two-payer fills, the primary's and secondary's `EvoucherAmountPaid` and `DirFeeTotal`
  separately, to show which row really carries them. Counts only.

---

# Part B — September measured against the standard

**Checkpoint.** A fresh snapshot of live, 15 September 2026, evening, measured with
`scripts/support/measure-lifecycle.ts`: read-only apart from the result cache's audit tick. Scope is September fill
dates with test imports excluded: 3,841 claim rows (2,971 paid, 870 reversed), 2,894 fills. Counts and dollars only.

## Rule 1 — who owes what

| # | measured | result | state |
|---|---|---|---|
| B1 | fills whose shares + patient ≠ fill total price | the pull's last check (13:40 UTC): **2 of 2,903** fills do not add up; 2 fills are on the site only. The fill total price is not stored, so the site cannot re-check | captured (in a setting nobody reads) |
| B2 | fills with 2+ paid rows | **76** (153 rows, remit $28,986.28): **65** on different BINs (real two-payer), **11** on the same BIN | measured |
| B2c | same-BIN fills whose rows share PCN and group | **8**. PioneerRx (P-1, session 1): 6 are real two-payer fills under one BIN, 1 carries a $0 phantom row, 1 is a misprinted-reversal fault. See G-LC-1 | **answered** |
| B2 | position (primary / secondary) stored | on **no** row | measured-and-none |
| B2 | backfilled single rows | **30** (remit $2,710.13); how many were two-payer fills collapsed into one is not measurable from the site | never-measured |
| B3 | voucher copied onto both rows of a two-payer fill | **2** fills, the same figure on each; a row-level sum counts **$50.04** twice | measured |
| B3 | DIR on the claims | **0** claims carry `dir_fee_cents`, so the copy-onto-both-rows fault is latent, not live | measured-and-none |
| B4 | negative remits (network fees) | **18**, **−$108.65** (see below), all netted into revenue today | measured |

The 18 negative remits by payer:
- CVS Caremark: 004336 ×4, 020099 ×1
- OptumRx: 610011 ×2, 610127 ×2, 610652 ×1
- ScriptSave ×3, Hippo ×2, Navitus ×2, Capital Rx ×1

**G-LC-1. A misprinted reversal left one fill paid twice. The other 7 suspects were not duplicates.**

*As first written (82e4d5b):* "8 fills carry two paid claims from the same plan … $3,401.46", suspect, awaiting
PioneerRx. **That test was wrong in its key: the same BIN, PCN and group is not the same payer.** Several plans
adjudicate a primary and a secondary under one BIN. Answered by session 1 reading PioneerRx (P-1), fix 214fdad:

| fills | what PioneerRx holds | on the site | verdict |
|---|---|---|---|
| 6 (BINs 610097 ×4, 610502 ×2) | two pay methods; `PrimaryClaimID` set on the second; primary and secondary last valid claims | agree with PioneerRx on all six; the intermediate rebills and reversals on two of them paired correctly | **real two-payer fills**, not duplicates |
| 1 (003858) | a paid claim, then a "D" duplicate response ($0, `IsDuplicateClaim = 1`) | the daily report printed the D as paid $0.00, so the site holds a $0 phantom paid row | no money; a $0 extra row to handle in part C |
| 1 (012833) | billed, reversed, billed, reversed, billed a third time at $101.18. Each reversal is −$89.44 | the report printed both reversals' amount as −$178.88 (copay correct), so exact-negation pairing failed; both $89.44 claims stayed paid beside two unmatched reversals; the $101.18 claim is not on the site yet | **fault**: remit $178.88 against a true $101.18, copay $149.98 against $74.99 |

OBSERVATION: one fill carries two paid claims whose reversals the daily report misprinted, overstating remit by
$77.70 and patient pay by $74.99. The other 7 are correct or carry no money.
SHOULD BE: a reversal cancels the claim it reverses, however the report prints its amount. A fill's payers are told
apart by pay method and position, never by BIN, PCN and group.
DIFFERENCE: yes, on one fill. **FIXED in 214fdad (session 1).**
- The reader pairs a non-negating reversal in the same file on fill, BIN, NDC and copay when every candidate has
  identical figures.
- The Claims recheck pairs stranded reversals only under strict conditions: same import, equal counts, identical
  figures, the copay cancels.
- The live rows repair when the owner presses recheck on Claims after deploy; session 1 confirms the count. **Not
  yet re-measured here.**

For rule 1: identifying the payer needs the position PioneerRx holds (P-4), which is one more reason to store it.

## Rule 2 — accrual

| # | measured | result |
|---|---|---|
| B5 | fills sold in September | 2,517, revenue $247,210.87 |
| B5 | dropped from revenue for unknown cost | **4** fills, **$2,295.78** |
| B5 | MTF promised on sold fills, not yet paid, therefore missing from accrual revenue | **14** fills, **$4,056.21**, none paid yet |
| B6 | matched payments whose fill key differs from their claim's (never reach revenue) | **0** of 80 (the fault is latent) |

**G-LC-2. Accrual revenue leaves out money the fills earned.**
OBSERVATION: $2,295.78 on 4 fills is dropped because their cost is unknown. $4,056.21 of MTF promises on 14 fills is
not revenue until the facilitator pays.
SHOULD BE: revenue is recognised in full when the prescription is sold, whether or not its cost is known (margin is
what cannot be computed) and whether or not the facilitator has paid (the promise is a receivable).
DIFFERENCE: yes, **$6,351.99** of September accrual revenue understated.

## Rule 3 — cash

| # | measured | result |
|---|---|---|
| B7 | September cash receipts | third party $275,121.78; patient (card batches) $34,112.41 |
| B7 | counter cash and cheque deposits | **no September bank statement on file**: expected-not-yet. In August all 7 counter "Deposit" lines were unplaced (money map section 13) |
| B7 | charge-account fills sold | 5, with a patient receivable of $0.00; there is nowhere to record a charge-account payment |

**G-LC-3. Cash copays and cheques never become cash revenue.**
OBSERVATION: September's patient cash is card batches only. The counter deposits that carry cash and cheques stay
unplaced on the bank statement (August: 7 of 7).
SHOULD BE: every copay collected is cash when collected, whatever the tender.
DIFFERENCE: yes, of unknown size until September's statement is read. Card batches also include retail card sales,
so "patient payments banked" is not the copay figure.

## Rule 4 — settlement

| # | measured | result |
|---|---|---|
| B8 | payments on two-payer fills | **5** ($30.26), all plan, each equal to the remit of the row it chose (attributed by amount; no BIN passed) |
| B8 | in-books payments for September fills with no claim | 10, net −$7.35 (the paid-and-reversed pairs); ambiguous choices are not stored, so how many were ambiguous is not measurable |
| B9 | MTF payments settling a plan share | **0** on September claims (15 MTF payments in books, none on a September claim): latent |
| B10 | paid September claim rows by state, on remit only | WAITING **1,717** $247,234.59; PAID **57** $4,120.30; OVERPAID **1** $9.67; PART-PAID **0**; cash plan 465 ($347.42); nothing owed 731 (−$108.65: fees and zero remits) |
| B10 | reads PAID on remit but carries an unsettled voucher | 0 |
| B11 | BINs with September remit that have never had a payment matched (not cash plans) | **47 of 52 BINs**, **$174,192.86** (largest below) |

The five largest of those 47 BINs: 019158 ×41 $41,576.95; 610011 ×79 $24,880.49; 610097 ×133 $14,614.08;
610279 ×106 $12,659.99; 015581 ×107 $10,551.65.

**G-LC-4. Most of September's receivables have no settling document the site reads yet.**
OBSERVATION: 47 of 52 paying BINs, $174,192.86 of remit, have never had a payment matched to any claim. The only
settling documents read so far are 9 AccessHealth reports (to 11 September) and a handful of 835s.
SHOULD BE: every share has an expected settling document:
- a plan paid through the PSAO: its AccessHealth report or ProviderPay 835;
- a direct payer: its own 835;
- a voucher: its programme's report;
- the MTF share: its MTF 835.
DIFFERENCE: part expected-not-yet (the later AccessHealth reports), part **no reader**: direct payers' 835s are not
received (Q-835-1 declined for September). Which BINs route through the PSAO and which pay direct is not recorded per
claim, so the split cannot be measured today.

**G-LC-5. Nothing says a claim is paid.**
OBSERVATION: `claims.status` is only paid or reversed. The reconcile states in `claim-reconcile.ts` are used only by
tests.
SHOULD BE: a claim carries WAITING / PART-PAID / PAID / OVERPAID per share, from its shares and their payments.
DIFFERENCE: yes. B10 above is the first count, computed on remit alone, before voucher, secondary and MTF shares.

## Rule 5 — the till

| # | measured | result |
|---|---|---|
| B12 | claims' patient pay on the sold day vs card batches | patient pay $44,044.71 over 11 sold days; card batches 8, $34,112.41; days with both 8; card ÷ copay per day, median **0.95** |

On the days both exist, card takings are near the copays. Near, not equal, is expected: card batches carry retail
sales, and cash and cheque copays are absent. Only the payment-type report splits the till by tender (G-CARD-5, sample
declined), so the comparison stays unmeasured at the precision the standard asks.

## Unmeasured, and why

- **The voucher case of the identity:** whether `TotalPricePaid` includes the voucher, and whether a Veridikal
  voucher sits inside the remit. Needs Q-P1 and the next pull (`evoucher_message_cents`).
- **Which row really carries a voucher or DIR on a two-payer fill:** Q-P2.
- **The 8 same-plan duplicate fills:** Q-P3.
- **Cash copays and cheques:** the September bank statement.
- **PSAO versus direct routing per BIN:** not recorded anywhere.
- **The till by tender:** the payment-type report.

## Summary for session 1

| finding | dollars (September) | kind |
|---|---|---|
| G-LC-1 a misprinted reversal left one fill paid twice (first stated as 8 fills, $3,401.46; 6 were real two-payer fills, 1 a $0 row) | $77.70 of remit and $74.99 of patient pay overstated on one fill | FIXED 214fdad; repairs on the owner's recheck |
| G-LC-2 accrual leaves out unknown-cost fills and unpaid MTF promises | $6,351.99 understated | rule 2 |
| G-LC-3 cash copays and cheques never banked | unknown until September's statement | rule 3 |
| G-LC-4 receivables with no settling document read | $174,192.86 across 47 BINs | rule 4, part expected-not-yet |
| G-LC-5 no claim state | 1,717 waiting, 57 paid, 1 overpaid | rule 4 |
| rule 1 (c) voucher copied onto both rows | $50.04 counted twice by a row sum | rule 1 |
| rule 1 (f) network fees netted | −$108.65 | rule 1; fixed for AR on a branch |
| latent: fill-key vs claim-id revenue; MTF settling the plan share; DIR copied | $0 today | rules 2 and 4 |
