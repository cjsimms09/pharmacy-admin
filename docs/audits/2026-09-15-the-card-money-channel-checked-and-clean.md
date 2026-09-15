# The card money channel: checked against the double count, and clean

15 September 2026 · helper B (cloud) · rule 6 reading of `7b9ae83..b801d10`, eight commits.
`npm run check` clean on the merge: **3,400 tests, 755 suites**.

**There is no finding here.** I went looking for one, had a specific hypothesis, and the code
refutes it. Recording that, with the reasoning, so nobody re-derives it — and because rule 1 is
explicit that where OBSERVATION and SHOULD BE do not differ, this is not a finding.

---

## What I was looking for

Counter money entered the cash account for the first time: `9cb9828` banks eight card settlement
batches, **$34,112.41**, 3–14 September, as patient cash receipts keyed `card-batch|<batch id>`.
That is a third road to a dollar that also travels as a bank deposit, and `9cb9828`'s own closing
note flags the premise:

> *"Not proved: whether the processor deposits each batch whole and on its own. … If fees are netted
> or weekend batches are combined, an exact-amount bank match will miss — to be checked on the first
> statement."*

The hypothesis: a miss is not neutral. `matchHeldDeposit` (`deposit-gate.ts:177`) matches on
`h.amountCents === line.amountCents` — exact — and returns `{ kind: "none" }` otherwise, and on none
the line **banks as today**. So if the processor deposits net of fees, the bank line would not equal
the batch total, the gate would find nothing, and the same counter money would be banked twice — in
the one direction that inflates revenue, silently, with no bank statement yet read to have shown it.

## Why it does not happen

Session 1 answered their own caveat three commits later, in `5cdff17`, from the real statement:

1. **`card-statement.ts:18`** — *"Each batch reaches the bank whole, the next day, weekends
   included."* Read off the statement rather than assumed, which is what the caveat asked for.
2. **`card-statement.ts:25`** — *"**Never the deposits.** They are the same money as the daily card
   batch reports, which are already banked."* The statement reader deliberately does not bank its own
   deposit rows.
3. **`card-statement.ts:152`** — the netting condition is **detected, not absorbed**:
   ```ts
   if (row[3] !== "-") problems.push(`batch ${row[1]} has ${row[3]} held back as a daily discount — fees are now being netted from deposits`);
   ```
   and a statement with any problem returns `ok: false` with *"Nothing was recorded."* That is
   exactly the condition my hypothesis needed, caught by name.
4. **The fee side fails closed too.** `bank-statement.ts`, `card_fees`: a fee debit matching no card
   processing bill is left **unplaced** with *"Forward that month's statement to the inbox rather
   than booking this by hand, or the fees will be counted twice when it arrives."* An unmatched
   charge is not guessed at, and the guidance points away from the double count rather than into it.

That is the asymmetry a deposit control should have: where the site cannot tell new money from the
same money net of a charge, it says so rather than choosing the answer that inflates revenue.

Also checked and right: the accrual account is untouched and a test fails if the accrual branch ever
reads cash receipts, because accrual recognises this revenue from the claims and the till. The
batch total is net of returns and that was settled against a real batch with returns
(780961413: $4,262.08 − $32.81 = $4,229.27), so the figure banked is the net the processor settles.

## The one residual, as a question rather than a finding

The netting detection lives on the **monthly** statement; the batches are banked **daily**. If the
processor began netting fees mid-month, that month's batches would already be banked gross and the
bank lines would arrive net — an exact-amount miss, and a double bank — until the month's statement
arrived and refused. The window is at most one statement cycle.

I am not reporting this as a finding because its premise is false today: the statement has been read
and says each batch reaches the bank whole. It is worth one line in the register as something to
watch rather than something to fix, and if it is ever worth closing, the close is cheap — the
statement already carries the per-batch deposit rows, so a bank line equal to
`batch total − that batch's discount` is matchable.

## Pre-flight

1. Physical act — the owner reading in the first bank statement, which has not happened yet.
2. Time — the first statement, and every month after. 3. Pharmacist's knowledge — n/a; a merchant
services question. 4. **Whose money, which basis, already counted elsewhere** — his, cash basis, and
"already counted elsewhere" was the entire hypothesis; the answer is no. 5. Units — cents; the
returns sign was settled on a real batch. 6. n/a. 7. Worst case ranked — money only, and it does not
occur. 8. **Could the check pass for the wrong reason** — this is the reverse: my *finding* would
have failed for the wrong reason, and I checked the statement reader before writing it rather than
after. 9. When he needs to know — nothing to tell him. 10. Registers — HANDOFF updated with the
clean result. 11. What else reads this figure — `addCashReceipt` → `gateDeposit` is the single door
for all three roads, which is what makes the answer checkable at all. 12. **What I did not check** —
whether the eight batches' amounts do in fact appear on the bank statement unchanged, because no
bank statement has been read yet (`bank_lines` is empty). That is the measurement that would turn
this from *reasoned* to *proved*, and it belongs to the pharmacy computer.
