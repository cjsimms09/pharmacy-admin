# "Nothing was ever counted for them" is what the screen says; the date is all the code tests

*12 September 2026 — session 2 (cloud). Audit of `693114d`, "Forget pre-September reversals, and say
the ones that still need a person". Concerns `src/lib/claims.ts:783-806` and
`src/app/(app)/claims/page.tsx:263-284`. **No file of session 1's is edited.***

## The half with money in it is right, and it is the better half

`stillStranded` was computed, passed up through `recheckHeldClaims`, and rendered on no screen —
$1,277.03 of reversals that may still be standing as revenue reaching nobody, beside a sentence that
cheerfully reported what *had* been paired. Putting it on the page is the right fix, and refusing to
pair a reversal whose figures do not exactly cancel a live claim is right too: the Wegovy reversal
carries an $833.52 copay the live row does not, because the copay moved to a card, and cancelling the
wrong run deletes revenue that was really earned. None of that is in question.

Three things about the other half.

## One: the code sets aside on the date; the reason given is that there is nothing to cancel

```ts
if (found.hit === null) {
  if (isOutOfBooks(rev.dateFilled)) { beforeTheBooks++; continue; }
  stillStranded.push({ … });
}
```

The justification beside it — *"there is nothing for it to cancel: the run it reverses was dispensed
before this site was given a report, so no revenue was ever counted for it and pairing would move no
figure"* — is a claim about **whether a live claim exists**. The test is a claim about **the date**.
They are not the same test, and the file already knows how to ask the first one: `claimCancelledBy`
returns a `why` that distinguishes *"no live claim is held for that prescription, fill, BIN and
NDC — it reverses a dispensing from before this feed began"* from *"N live claims are held for that
fill but none has figures this exactly cancels"*.

Run, against a migrated database holding one August fill and one September fill, each with a live
paid row and a reversal whose copay moved to a card — the same shape as the Wegovy reversal:

```
strays          : 2
paired          : 0
beforeTheBooks  : 1    <- counted, never named
stillStranded   : [ { "rxNumber": "337203", "dateFilled": "2026-09-09",
                      "amountCents": -60594,
                      "why": "1 live claim is held for that fill but none has figures this exactly cancels" } ]

the August reversal's own why: 1 live claim is held for that fill but none has figures this exactly cancels
```

The August reversal's own reason says a live claim **is** held for its fill. It is set aside anyway,
and the screen then tells the owner:

> *"1 reversal of dispensings from before 1 September was left alone, **because nothing was ever
> counted for them**"*

That sentence is asserted, not tested. Where it is false, $461.89 stands as revenue and the page says
it is fine.

**And the rule is applied only where it can do damage.** The `isOutOfBooks` check sits *inside*
`found.hit === null`, so a pre-books reversal that **does** cancel a live claim exactly is still
paired and still written to the database (`paired++`, `.update(schema.claims)`). "Forget about
pre-September reversals" is therefore not applied to the ones that pair — only to the ones that need
a person, which are the ones with money at stake.

The one-line version, keeping his decision and making the sentence true: set aside on
`isOutOfBooks(...) && found.why.startsWith("no live claim is held")` — forget the ones that really
have nothing to cancel, and name the ones that do.

## Two: `isOutOfBooks` is a received-date test, and this passes it a fill date

`books-start.ts` settles the boundary and argues the point explicitly:

> *"**Why the received date and not the fill date** — His words are 'payments from before 09/01': the
> test is when the money arrived. That is also the safe reading. A September remittance settling an
> August fill is real money in these books, and **a fill-date rule would throw it out — quietly
> losing revenue in the name of tidiness**."*

Its parameter is named `receivedOn`. `claims.ts:801` calls `isOutOfBooks(rev.dateFilled)`. Both are
`string`, so nothing catches it. An August fill paid by a September remittance is money in these
books — `claim-payments.ts:105` counts it, keying on `receivedOn` exactly as the docstring says —
and its reversal is now forgotten on the fill date, which is the substitution that docstring names as
the error.

Two other call sites pass fill dates too: `claims-backfill.ts:156` (`isOutOfBooks(newestFill)`,
deciding whether an upload is a test pull) and `mac-appeal-store.ts:245`
(`isOutOfBooks(input.dateFilled)`, where an appeal window really does start at the fill). Both are
defensible on their own, which is precisely what makes the drift invisible: the function's name says
one thing, three of its four callers ask another, and only this one changes money. A `receivedOn`
type, or a second exported `fillIsOutOfBooks`, would make each call state which question it is
asking.

## Three: a sentence that reads as a total is built from a list capped at twenty

```ts
return { paired, strays: strays.length, beforeTheBooks, stillStranded: stillStranded.slice(0, 20) };
```

and the page:

```tsx
`${r.stillStranded.length} reversals could not be matched …, so up to ` +
`${(r.stillStranded.reduce((n, x) => n + Math.abs(x.amountCents), 0) / 100).toFixed(2)} may still be standing as revenue`
```

`strays` and `beforeTheBooks` are full counts; `stillStranded` is a page of at most twenty. Today
that is 28 = 0 paired + 23 before the books + 5 named, and it adds up. With thirty needing a person
it reads "20 reversals … so up to $X", where the count is wrong, the money is the sum of twenty of
thirty, and nothing on the screen says so. The commit's own promise — *"so the count adds up and
nothing is silently dropped"* — holds only below the cap.

Either return the count separately from the list, or say "showing 20 of 30".

## Small

The comment at `claims.ts:794` says *"All twelve on file today are dated between 19 and 28 August"*.
The commit message says twenty-three, and 28 − 23 = 5 is the figure the rest of the message uses. The
comment is the one a future reader will trust.

## For session 1

One count only the pharmacy computer can take: **of the 23 stranded reversals dated before
1 September, how many have a live paid claim on file for their own prescription, fill, BIN and NDC?**
`claimCancelledBy(rev, live).why` answers it directly — anything not beginning *"no live claim is
held"* is a reversal with something to cancel that is currently being forgotten on its date.
