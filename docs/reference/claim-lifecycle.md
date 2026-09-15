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
