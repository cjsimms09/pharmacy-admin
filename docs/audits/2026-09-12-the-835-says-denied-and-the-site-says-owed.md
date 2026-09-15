# The remittance says "denied". The site goes on saying "owed", and keeps the word as an integer.

*12 September 2026 — session 2 (cloud). `src/lib/x12-835.ts:552-567` against
`src/lib/claim-payments.ts:463-487` and `src/lib/payer-owed-store.ts:85-100`. **No file of session 1's
is edited.***

## The 835 reader is sound, checked at four points

Before the finding, what was checked and cleared, so nobody checks it twice:

1. **Bundled files.** `parse835Sets` exists *and is wired* — `claim-payments.ts:402` calls it, not
   `parse835`. A five-payer bundle is read as five remittances.
2. **The arithmetic gate really gates.** `claim-payments.ts:500` returns before storing anything when
   `balance.differenceCents !== 0`, and says so in words rather than returning an empty report.
3. **The null-balance case cannot sneak past it.** `balance` is null only when there is no BPR02 or no
   payment carried an amount, and `payableOnly` drops every payment whose amount is null or zero — so
   a file that cannot be checked also has nothing to post.
4. **`p.paidCents!`** at `:526` is safe for the same reason: `payableOnly` has already removed the
   nulls.

That is a carefully built reader. The finding is not in it.

## What a denial does

Run, on a remittance paying one claim $100.00 and denying another (CLP02 = 4):

```
BPR02 paid      : 10000
payments parsed : 336548 status=1 paid=10000  |  336549 status=4 paid=0
balance         : {"paidCents":10000,"claimsCents":10000,"adjustmentsCents":0,"differenceCents":0}
problems        : (none)

kept            : 336548
skipped         : [{"reference":"336549","why":"denied — nothing was paid"}]

what the store keeps of that:  skipped: 1
```

Three things, in order.

**The file balances, correctly.** A denied claim contributes nothing to `claimsCents` and nothing to
BPR02, so the identity closes and `problems` is empty. The arithmetic gate is not meant to catch this
and does not. Right.

**The denial is read, and named.** `statusCode` is CLP02, parsed at `x12-835.ts:421`, and
`payableOnly` turns `4` into the sentence *"denied — nothing was paid"* (`:561`). The payer has told
the pharmacy, in writing, that it is not paying this claim.

**Then the sentence becomes an integer.** `importOneRemittance` does
`const { keep, skipped } = payableOnly(r)` at `:463` and returns `skipped: skipped.length` at `:483`.
The references and the reasons go nowhere else — `statusCode` has exactly one use in the whole
repository, and it is that discarded sentence:

```
src/lib/x12-835.ts:59   statusCode: string;
src/lib/x12-835.ts:421  statusCode: (f[2] ?? "").trim(),
src/lib/x12-835.ts:561  why: p.statusCode === "4" ? "denied — nothing was paid" : "paid nothing"
```

## Why that costs money

Receivables are built from what the **adjudication** said the plan would pay, not from what the
remittance did: `payer-owed-store.ts:85-100` walks every fill and pushes one row per payer at
`shares[i]?.receivableCents ?? p.remitCents`. Nothing in that path consults an 835 denial, because
nothing wrote one down.

So a claim the plan adjudicated as payable and later denied on the remittance stays in the
receivables at its adjudicated amount. It does not vanish — `ageOutstanding` will carry it into the
30, 60 and 90 day buckets — but it ages there as *"the payer owes this"*, when the payer has said in
writing that it does not. The pharmacy chases it, or writes it off late, or never notices.

The same applies to CLP02 = **22**, a reversal of a previous payment, where the payer sends it with
no amount: `payableOnly` skips it as "paid nothing" and the reversal is recorded nowhere.

## The fix is the one session 1 just made, one module over

`693114d`, eight commits before the head of this branch, found `stillStranded` *"computed, passed up
through `recheckHeldClaims`, and rendered on no screen anywhere"* and put it on the page — with the
money, the prescription and the date, and a sentence saying each needs a person. `skipped` already
carries `{ reference, why }` for every one. Returning the array rather than its length, and saying it
the way that commit says its own, is the same fix in the same shape:

> *"N claims on this remittance were denied and are still standing as owed: 336549 … Each needs a
> person to decide whether to appeal it or write it off."*

Whether a denial should also mark the claim itself is a bigger question and belongs to session 1 —
it is their store, and `settleStaleFills` already shows the care that taking revenue off the books
deserves. Putting the denial on a screen needs none of that argument and loses nothing.

## For session 1

Two counts from the remittances already read:

1. Across the 835s on file, how many claim payments carry CLP02 = 4 or 22 with no amount? That is
   how many denials and no-amount reversals have arrived and been counted only as `skipped`.
2. Of those, how many name a prescription that is still in the receivables at its adjudicated
   figure? That is the money the site is saying it is owed and the payer has said it is not.
