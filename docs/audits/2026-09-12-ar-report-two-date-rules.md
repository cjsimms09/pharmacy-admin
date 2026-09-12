# The AR report cancels September receivables with payments for August fills

**Audited:** the queue left from the 11 September pushes — `books-start.ts` and migrations
0113/0114/0116, `ar-report.ts` with `payer-owed.ts`, and migration 0119. Base was quiet at
`1a8554f`. **By:** the cloud session (B). **Method:** the modules run.

One finding. Two areas checked and cleared, recorded so nobody checks them again.

---

## The finding: the two halves of the report use the two rules `books-start.ts` says are different

`books-start.ts` settles the boundary and argues, correctly, for the **received-date** rule:

> *"His words are 'payments from before 09/01': the test is when the money arrived. That is also the
> safe reading. A September remittance settling an August fill is real money in these books, and **a
> fill-date rule would throw it out — quietly losing revenue in the name of tidiness**."*

The AR report applies the received-date rule to one side and the fill-date rule to the other:

```ts
receivablesAsAt: r.dateFilled >= SITE_STARTS_ON && r.dateFilled <= asAt     // ar-report.ts:150
receivedAsAt:    !isOutOfBooks(p.receivedOn) && p.receivedOn <= asAt        // ar-report.ts:163
```

Each is defensible alone. On opposite sides of a subtraction they are not: `owedByPayer` does
`outstanding = max(0, billed − got)`, so a September payment settling an August fill is added to
`got` for a payer whose August fill was never in `billed`.

Run, with one August fill and one September fill for the same payer, both paid in September — which
is the ordinary lag, two to four weeks after dispensing:

```
receivables kept: 1 of 2   (the August fill is dropped by dateFilled >= SITE_STARTS_ON)
payments kept:    2 of 2   (both received in September, so both are in the books)

  billed      $500.00   <- September fill only
  received    $600.00   <- includes $400.00 settling the AUGUST fill
  outstanding $  0.00
  state       overpaid
```

**$300.00 is genuinely owed and the report says nothing is.** `state: "overpaid"` is at least a
signal.

**The common case has no signal at all.** Give the payer the September business a real payer has:

```
  billed      $3500.00
  received    $ 600.00   <- still includes the $400.00 for the August fill
  outstanding $2900.00
  state       owes
```

True figure: $3,300.00. Understated by exactly the August payment, `state` reads the ordinary
"owes", and nothing on the page says a number is missing. `Math.max(0, …)` means the error can only
ever hide, never show as a negative.

**Why the existing guards do not catch it.** The loader filters `claimPayments.outOfBooks`, which is
set from `received_on < 2026-09-01` — so a payment received in September is in the books whatever it
settled. Its comment gives the reason it believes it is safe:

> *"A payment from before the books begin settles nothing here, because the fill it settled is not in
> here either."*

That holds for a payment received **before** 1 September. It does not hold for one received after,
which is exactly the population this creates. `owedByPayer` has the right instinct one level up —
`if (!a) continue;`, so a payment whose *payer* has no receivable is left out — but a payer with any
September business has an `a`, and the August money lands in it.

**How big, and only 1 can answer:** every August fill paid in September is one of these, and August
fills are on file deliberately, so the August 835s have something to match. The query is one line —
claim payments with `received_on >= '2026-09-01'` joined to claims with `date_filled < '2026-09-01'`,
summed. It is in HANDOFF.

**Fix:** make the two sides agree. Either exclude a payment whose claim is not in the receivables set
(the claim-level version of the `if (!a) continue;` rule already there), or include the August fill
as a receivable when a payment for it is being counted. The first matches the report's stated
purpose — *"an August fill is not this pharmacy's September receivable"* — and is the smaller change.
What must not stand is counting one and not the other.

---

## Checked and cleared

**The books cut-off is applied where it matters.** `books-start.ts`'s claim is that *"every query
that adds money up excludes them"*, and the readers that add money up do: `profit-and-loss.ts`,
`payer-owed-store.ts`, `ar-report.ts`, `reversed-fill-payments.ts`, `expenses.ts` and
`claim-payments.ts` all filter. The four files that touch these tables without the flag are not
book totals — `copay-remit-store.ts:181` and `payer-payments-store.ts:55` are dedupe lookups,
`inbox-undo-store.ts` sums only what it is about to delete, and `remits/page.tsx:91` counts a month
to decide which month to offer. Two of those return figures that would include test money if asked
about August (`payerPaymentsFor`, and the remits page's count), and neither feeds a total the owner
reads as his books. Not reported; recorded so the next pass does not re-derive it.

**Migration 0119 holds, on every count it claims.** Run against the migrated database:

```
first mac_appeal, claim C1                   INSERTED
SECOND mac_appeal, same claim C1             REFUSED: UNIQUE constraint failed
floor_complaint, same claim C1               INSERTED     <- a different argument to different people
mac_appeal, different claim C2               INSERTED
claim_id NULL, either kind, twice            INSERTED     <- floor complaints carry ids in claim_ids
re-file C1 after the first was withdrawn     REFUSED      <- the slot is held, deliberately
```

The predicate matches what is actually written: `kind` is a typed enum and both writers
(`appeals.ts:220`, `mac-appeal-store.ts:218`) use the literal `"mac_appeal"`, so the guard is live
rather than a predicate that never fires. And the writer handles the violation rather than throwing
a raw constraint error at the owner — `mac-appeal-store.ts:236` catches it and returns *"That claim
already has an appeal on file, so nothing was recorded a second time."* Nothing to do here.

**0115 is left free for this session, and is noted in 0116's own comment.** I have taken no
migration slot.

## For 1

1. One rule for which claims a payer's money belongs to. The finding above.

**Question under "Open items":** how much was received in September against fills dated before
1 September? That is the size of it, and it is one query.

Nothing in `books-start.ts`, `ar-report.ts`, `payer-owed.ts`, `payer-owed-store.ts` or
`mac-appeal-store.ts` was edited by me.
