# The rule worth stating twice is now stated once and a half

14 September 2026 · helper B (cloud) · rule 6 reading of `6e97203..284547b`, eleven commits.

`npm run check` clean on the merge: **3,336 tests, 735 suites**, build compiled.

---

## Read and clean

**`284547b` — the $1,572.90 of August refunds.** I ran the new gate in `books-start.ts:58` through
every case rather than reading it:

```
dateFilled 2026-08-15, receivedOn 2026-09-05  → out of books   ← the fourteen, correct
dateFilled 2026-12-31, receivedOn 2026-08-27  → out of books   ← the placeholder, correct
dateFilled 2026-09-10, receivedOn 2026-09-12  → in books       ← correct
dateFilled 2026-08-15, receivedOn null        → out of books   ← credibility untestable, and safe
```

The fourth is the only one the prose does not name: with no received date there is nothing to test
credibility against, and the fill is trusted anyway. It is safe in both directions — a placeholder
with no received date reads `2026-12-31 < 2026-09-01` false and stays in the books, exactly as
before — so it is not a finding, but it is the one case a later reader will wonder about.

**`829787e` — basis 46.** Identified from the plan's own *Est. MTF* column rather than from the
basis code, with the code only corroborating: that is "nothing is inferred where a document could say
it" kept where it would have been easy to infer. Routed ahead of the other remedies for a stated
reason, and deliberately not actionable because CMS pays on its own schedule. **No fault.** I checked
the one interaction with `284547b` that could have bitten — the fourteen out-of-books MTF refunds
settle **August** fills, while the basis-46 claims are **September** fills whose refunds will name
September and stay in the books. The two fourteens are different fourteens and they do not meet.

**The nine dates.** Corrected, and session 1 found three more than I did. `CLAUDE.md` rule 6 now
carries a `Read-By:` trailer protocol, and is careful to say the trailer is trustworthy only in the
negative. I have adopted it.

## The finding

```
OBSERVATION: `284547b` gave `isOutOfBooks` a fill-date rule (`books-start.ts:58`): a payment naming
             a credible fill date is judged on that date rather than on the day the money arrived.
             `recordClaimPayment` writes the result to `claim_payments.out_of_books`, and
             `payer-owed-store.ts:79` excludes on that stored column.

             `ar-report.ts:163` applies the test a second time — `receivedAsAt`, filtering on
             `!isOutOfBooks(p.receivedOn)` with no second argument, so the **old** received-date-only
             rule. Its docstring says the duplication is deliberate: *"The out-of-books test is
             applied again here even though the loader already excluded those rows in SQL — this is
             the report the owner named by name, and a rule worth stating twice is this one."*

             The two statements now disagree. On the fourteen refunds that `284547b` was written
             about — August fills, September money — the stored rule says out of books and
             `receivedAsAt`'s copy says in.

             It cannot be brought into step as it stands: `Received` (`payer-owed.ts:59-67`) carries
             `bin`, `payer`, `cents`, `receivedOn` and `matched`, and **no fill date**.

SHOULD BE:   A check duplicated on purpose is a backstop, and a backstop exists to hold in the case
             the primary fails. One that encodes an older and weaker version of the rule provides no
             defence against precisely the case the rule was changed to catch — which is the only
             case worth defending. Either it states the same rule, or the docstring should not claim
             it is the rule stated twice. This project's own words for it, written three hours
             earlier in `drug-cost-source.ts:12-15`: *"Two readers for one thing drift; two readers
             where one of them is unused drift silently."*

DIFFERENCE:  Yes, and it is **latent rather than live — no money moves today, and I want that said
             first.** `receivedAsAt` is a filter applied downstream of a loader that has already
             excluded those rows in SQL, so a weaker test there removes nothing extra and admits
             nothing. It has exactly one caller (`ar-report-store.ts:54`) and that caller feeds it
             from the excluding query.

             What differs is the guarantee. The moment the SQL is relaxed, or a second caller feeds
             `receivedAsAt` from anywhere else, the backstop on the report the owner named by name
             passes an out-of-books payment straight through — and the docstring will still say the
             rule is stated twice.
```

Ranked **money, not live**, with #18. Below every finding that is biting now, and I have placed it
there rather than at the top.

## The fix, which is not one line

`Received` has no fill date, so `receivedAsAt` cannot ask the new question. Two ways:

1. **Carry it.** Add `dateFilled` to `Received` in `payer-owed.ts`, populate it in
   `payer-owed-store.ts`, and pass it: `!isOutOfBooks(p.receivedOn, p.dateFilled)`. The backstop
   then states the same rule and the docstring becomes true again.
2. **Or drop the claim.** Filter on the stored `out_of_books` the loader already decided, and change
   the docstring to say the report trusts the column rather than re-deriving it. That is a smaller,
   honest defence — one rule, one place — and it removes the drift by removing the second reader.

Either is right; what is not right is the present state, where the sentence promises the first and
the code does the second badly. **Both are session 1's** — `ar-report.ts`, `payer-owed.ts` and its
store are theirs.

## Pre-flight

1. Physical act — the owner printing the monthly AR report he asked for by name. 2. Time — not this
month; the month the SQL changes or a second caller appears. 3. Pharmacist's knowledge — n/a; this is
a controls question. 4. Whose money, which basis, which period — his receivables, as at a month end;
nothing double-counted, and the figure is unchanged today. 5. Units — cents and ISO dates, string
comparison, verified on the four cases above. 6. n/a. 7. **Worst case ranked** — money only, and
latent; no patient, board or PBM exposure. 8. Could it pass for the wrong reason — **yes, and that is
the whole finding**: it passes today because something upstream is doing the work, which is exactly
what a backstop is not supposed to depend on. 9. When he needs to know — not urgently; before the
loader is next touched. 10. Registers — `docs/registers/` generated, not mine; HANDOFF index updated.
11. **What else reads this figure** — `isOutOfBooks` has seven call sites. Three pass a *fill* date
in the first position (`claims.ts:801`, `claims-backfill.ts:156`, `mac-appeal-store.ts:265`), which
is correct under the one-argument behaviour and unaffected by the new branch. `expenses.ts:303` is
about bills, not claim payments, and correctly has no fill date to give. `claim-payments.ts:105,109`
are the two that were updated. That leaves `ar-report.ts:163`, this finding. All seven checked.
12. **What I did not check** — whether the fourteen repaired rows are the only ones affected
historically, and whether any *other* stored `out_of_books` value predates the repair. Session 1 says
14 rows repaired and MTF payments in the books now total $0.00; I cannot verify either from here, and
have not tried to.
