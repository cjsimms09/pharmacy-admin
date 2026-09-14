# A rebate owed *to* the pharmacy sits inside the bills the pharmacy owes

14 September 2026 · helper B (cloud) · proactive scan, rule 3. Rebates had no audit file and the
owner's mandate names them, so that was the area. Most of what I found there is right; one thing is
not.

---

## What is right, said first so nobody re-derives it

I went in expecting the classic accrual fault — a wholesaler settles August's rebate in September,
so the discount lands in the wrong month. **It does not happen here, and the code that prevents it
is deliberate.**

- `intake/[id]/business-review.tsx:166` labels the field *"Statement date"* and hints *"Or the last
  day of the period it settles"*, and it **defaults to `read.periodTo`** — the period end the reader
  pulled off the statement's own `Start:…End:` line (`rebate-report.ts:135-141`).
- `intake/actions.ts:611-612` writes that date to `invoiceDate` and the money-arrived date to
  `paidOn`, separately.
- `expenses.ts:174` picks `invoiceDate` for accrual and `paidOn` for cash.

So August's rebate reduces **August's** cost of goods on the accrual account and lands in
**September's** on the cash account, and both are right. The double-count register
(`books-check.ts:205-235`) and the replacement rule (`profit-and-loss.ts:487-502`) hold too: the
statement replaces the ladder estimate rather than joining it, and on cash the receipt wins and the
bill saying the same thing is dropped. **Checked, and clean.**

---

## The finding

```
OBSERVATION: A rebate statement filed before the money reaches the bank is stored as a confirmed
             expense with a negative amount and a null paid date — intake/actions.ts:611-616 writes
             `amountCents: -amountCents` with `paidOn` null when nothing is banked. `unpaid()`
             (expenses.ts:188-193) selects on `paid_on IS NULL AND status = 'confirmed'` with no
             sign test, so that row is returned as an unpaid bill; the Spending page sums it
             straight into the tile — `owedCents = owed.reduce((n, e) => n + e.amountCents, 0)`
             (expenses/page.tsx:265), shown as **"Owed and unpaid"** (:287-292).

             Run against a migrated database with two genuine bills ($6,500.00 rent, $1,284.50
             payroll service) and one August rebate statement of $3,200.00 not yet banked:

                 rows inside unpaid(): 3
                     -3200    McKesson rebate statement 2026-08-01 to 2026-08-31
                      6500    September rent
                    1284.50   Payroll service

                 "Owed and unpaid" shows      $4,584.50 across 3 bills
                 Bills he must actually pay   $7,784.50
                 Understated by               $3,200.00

SHOULD BE:   A tile called "Owed and unpaid" is a payables figure: what the pharmacy must pay out,
             and nothing else. A volume rebate the wholesaler has settled but not yet remitted is
             the opposite side of the ledger — a receivable, money owed *to* the pharmacy. Basic
             accounting does not net a receivable against payables, and a pharmacy owner reads that
             tile to answer one question, "what do I have to cover this week". The schema says the
             same thing in its own words at schema.ts:2005 — `paidOn` is "When the money actually
             left: the cash date. **Null while it is still owed.**" A rebate not yet arrived has not
             failed to leave; it has failed to arrive.

DIFFERENCE:  Yes. One null is carrying two different states — *owed by us, not yet paid* and *owed
             to us, not yet arrived* — and the tile adds them. Every month he files the statement
             before the cheque clears, the money he must cover reads low by the size of the rebate,
             in the flattering direction, which is the direction nobody questions. On the figures
             above, by $3,200.00 for as long as the rebate is outstanding.
```

This is `CLAUDE.md` rule 5 exactly: *four states, never one word*. The rebate is
**expected-not-yet**; the rent is **captured** and owed. They are not the same state and they are
being given the same one.

### What it is not

Worth saying, because I checked both:

- **Not an accrual-period fault.** See above — the period is read from the statement and used.
- **Not a double count.** The row is the settlement itself, and both `profit-and-loss.ts:489` and
  `books-check.ts:222` already keep the ladder estimate out of a month that has one.
- **It does not reach the bank matcher.** `bank-statement.ts:340` matches on
  `b.amountCents === out` where `out` is a positive withdrawal, so a negative row can never match
  and nothing gets marked paid by mistake. Checked, inert.

The fault is the one tile, and only while the rebate is outstanding.

## The fix I would propose (session 1's to make — it is a store and a page)

Not `unpaid()` filtering negatives away: that would take the receivable off every screen and give it
the state *not-captured*, which is a different fault and a quieter one. Split it, so both states are
on screen and named:

```ts
// expenses/page.tsx, replacing :265
const payable = owed.filter((e) => e.amountCents > 0);
const receivable = owed.filter((e) => e.amountCents < 0);
const owedCents = payable.reduce((n, e) => n + e.amountCents, 0);
const dueInCents = -receivable.reduce((n, e) => n + e.amountCents, 0);
```

and a second `Figure` beside it — **"Settled, not yet in the bank"**, valued `dueInCents`, sub
naming the supplier and the period from the row's own description, tone `muted` rather than `warn`
because it is good news arriving late. Rule 4 wants the means to correct it on the same screen: the
row already carries `documentId`, so the figure opens the statement it came from.

## Pre-flight

1. Physical act — the owner filing a rebate statement on the Inbox the day it arrives, before the
   money does. 2. Time — now and every month the two dates straddle. 3. Pharmacist's knowledge —
   the wholesaler settles a month's rebate weeks after it closes, so this window is the normal case,
   not the edge. 4. Whose money, which basis — his, accrual tile, and the cash side is untouched.
   5. Units — cents throughout, verified negative-as-stored. 6. n/a. 7. Worst case — money only; no
   patient, board or PBM exposure. 8. Could it pass for the wrong reason — yes, and it did for me
   at first: the accrual period is handled so carefully that the sign is easy to trust along with
   it. 9. When he needs to know — before he next reads that tile to decide what he can cover.
   10. Registers — `docs/registers/` is generated and not mine to edit; HANDOFF index updated.
   11. **What else reads this figure** — `unpaid()` has three callers. `money/bank.ts:24` feeds the
   matcher, checked above and inert. `diagnostic-sources.ts:357` reports rather than decides.
   12. **What I did not check** — whether the owner in fact files the statement before the money
   arrives, or waits until it is banked and enters both at once. If he always waits, the window
   never opens and this is worth nothing. That is a question for the pharmacy computer and it is in
   `HANDOFF.md`; the code permits the window either way, so the split is worth making regardless.
