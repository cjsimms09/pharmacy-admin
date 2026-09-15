# `FOUNDATIONS.md`'s "still to be checked": nine items, answered from the code

*12 September 2026 — session 2 (cloud). Everything here is code-only, which is what I can see; the
five that need the database stay with session 1. **One finding in nine.** No file of session 1's is
edited.*

Session 1 wrote the list *"so they are not lost, and so the next question is not 'what else is
there'"*. Here is what the code says about each.

| # | Item | From my side |
|---|---|---|
| 1 | Partial fills and completion fills | **answered, with a query** — two fills, two scripts; dispensing status is **not-captured** |
| 2 | Narrow therapeutic index drugs | **FINDING** — no NTI concept exists, and the buy page leads with the saving |
| 3 | Inhalers and nasal sprays not substitutable | **clean, proved as asked** |
| 4 | DAW codes | already answered in your own §272 |
| 5 | DIR fees land months later, retroactively | **already handled** — and better than the item says |
| 6 | Credits reduce cost in the month the credit lands | **the reader takes the right date** |
| 7 | Compounds have no single NDC | **already handled** — caveated, printed, remedy named |
| 8 | 340B / contract pharmacy | **already handled** — same mechanism |
| 9 | Salt forms and esters | **clean** — `equivalenceKey` keeps them apart, deliberately |

## The one finding

**2. Narrow therapeutic index.** `substitutable()` returns true for two AB1 levothyroxines from
different manufacturers and for two AB warfarins, and no NTI concept or continuity-of-manufacturer
guard exists anywhere in `src/` or `scripts/`. Full write-up and the traced path to the screen — the
catalog page *leads* with "a cheaper equivalent exists" and its money — in
`docs/audits/2026-09-12-substitutable-and-the-narrow-therapeutic-index.md`. It ranks above every
money finding I have on pre-flight #7, and the list of molecules is the pharmacist-in-charge's to
choose, not mine.

## The five that were already right, so they can come off the list

**5. DIR fees.** The item says *"the accrual treats them as a hand-typed line, so an empty line means
nobody entered them rather than that there were none."* That is already said on the screen:
`profit-and-loss.ts:587` pushes to `missing` the sentence *"DIR fees and price concessions for the
month. These are entered by hand, so an empty line means nobody has entered them rather than that
there were none."* And `registers.ts:39`'s `DECIDED` table already carries
`"expense:DIR fees and price concessions": { state: "not-captured", note: "arrives months later,
retroactively per claim, entered by hand" }`. Both halves done. (`claims.dir_fee_cents` is populated
on 5 of 2,546 and read by no accounting module — but the accrual is not pretending otherwise, which
was the concern.)

**6. Credits and the month they land.** `ap-transactions.ts:368` takes
`date("Date Credited Back to Customer") ?? date("Invoice/Credit Date")` — the day the credit came
back, not the day of the purchase, which is the rule the owner decided on 10 September. The reader
has the right date. Whether the ledger then books it in that month is one step further and needs the
data.

**7 and 8. Compounds and 340B.** Already handled, and handled the way this codebase handles an
unknown elsewhere. `floor-review.ts:218-226` passes `isCompound: false` and `is340B: false` with the
reasoning written beside it:

> *"Passing false is assuming in the pharmacy's favour, which is exactly what this codebase refuses
> to do silently — so it is not silent. Each one is stated as a caveat on the review and printed
> wherever the review is, and the fix is a column on the export rather than a judgement here."*

and `:317` prints *"It carries no compound or 340B indicator either, and neither is priced against
NADAC. Ask for both columns."* The assumption is named, the caveat travels with the review, and the
remedy is stated. There is nothing here to find.

**9. Salt forms and esters.** `equivalenceKey`'s docstring says *"Salt forms are not collapsed
(amlodipine besylate is not amlodipine maleate here)"*, and the run confirms it: the two keys differ,
so `substitutable` is false.

**3. Inhalers and nasal sprays.** Proved rather than assumed, as asked. An unrated device is refused,
and an AB-rated product against an unrated one is refused too, because `isARated` fails on the null
before the group comparison is reached.

## The one that needs a query rather than an opinion

**1. Partial fills.** Two fills and two scripts, because `fillKey` includes the service date. The
deeper answer is that the site **cannot tell** a partial-and-completion pair from two ordinary
dispensings, because NCPDP's dispensing status is not captured anywhere. Whether the cost is doubled
turns on what PioneerRx puts in `acquisition_cents` on each row, and the query that settles both that
and the frequency is in
`docs/audits/2026-09-12-partial-fills-the-field-is-not-captured.md`.

## What is left for session 1

Of the nine, **one finding and one query**. The five listed as already handled need nothing. That is
the whole of what the code can say; the rest of that list — how often partial fills happen here, what
PioneerRx actually puts in each column — is the side of the handoff with the data on it.
