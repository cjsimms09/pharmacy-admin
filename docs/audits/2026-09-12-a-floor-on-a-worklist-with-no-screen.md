# The $30 floor is well judged. The worklist it was added to reaches no page.

*12 September 2026 — session 2 (cloud). Audit of `2d2123f`, "A floor under what is worth appealing,
and an error that names the control". Concerns `src/lib/mac-appeal-candidates.ts`,
`src/lib/mac-appeal-store.ts` and `src/app/(app)/claims/appeals/page.tsx`. **No file of session 1's
is edited.***

## The floor itself is right, and the care in it is the right care

A `too_small` verdict rather than a filter, so the claim keeps a reason. `MIN_WORTH_FILING_CENTS` in
one place with a note saying to remove the gate rather than tune it if filing ever stops costing a
code. "More than $30" taken literally, so exactly thirty does not clear it. The shortfall still
carried and still counted in `setAside`, with a test holding it, "because a verdict that zeroed it
would quietly write the money off". Asked after the gates that say a claim is not appealable at all,
so a screen never says "it is small" where the truer answer is "no MAC priced this".

Verified by running `worklist` — the ordering holds, the arithmetic holds, and exactly $30 is set
aside:

```
One claim, $40.00 short  -> batches=1  totalCents=$40.00   "1 claim worth $40.00 can be appealed."
Exactly $30.00 short     -> batches=0  setAside: too_small 1 claim $30.00
```

## The finding: none of this is on a screen

`macAppealWorklist` has one consumer in the whole repository, and it is not a page:

```
src/lib/mac-appeal-store.ts:6        imports worklist from ./mac-appeal-candidates
scripts/caremark-appeal-plan.ts:61   const { macAppealWorklist } = await import("../src/lib/mac-appeal-store")
tests/mac-appeal-candidates.test.ts:3
```

A script run by hand from a terminal, and the tests. `src/app/(app)/claims/appeals/page.tsx` — the
page the owner opens — is built on something else entirely: `appealQueue` from `appeals.ts`, at
`page.tsx:35`, and every figure, card and empty state on it comes from that queue.

Which matters because of what `mac-appeal-candidates.ts` says about `appeal-queue` in its own
opening lines:

> *"`appeal-queue.ts` answers a different question and answers it more strictly: it works out what a
> claim should have been paid from a contracted rate schedule, and returns nothing at all when no
> rate row covers the claim. **On this pharmacy's data that is 1,960 claims and an empty queue.**"*

So: the strict queue that comes back empty is the one on the screen, and the module built *because*
it comes back empty is the one with no screen. The owner opens Claims → Appeals and reads "Nothing
is ready" over 1,960 claims, and the module that would have said otherwise is reachable only by
someone at a terminal typing `tsx scripts/caremark-appeal-plan.ts`.

This is the shape `693114d` fixed for stranded reversals eight commits earlier the same day —
`stillStranded` computed, passed up, "rendered on no screen anywhere" — and the shape DAILY-CHECK.md
states in its own words: *a check that lands nowhere is not a check*. `2d2123f` is careful work, with
a constant, a verdict, a docstring and four fixtures revised, added to a worklist nobody can open.

## What the floor does to the sentence, which is the same fault one layer down

`setAside` carries the money, correctly. But the headline the worklist returns is about existence,
not worth. Run, forty claims from one payer each $25 short:

```
40 claims, $25.00 short each = $1000.00 on the table
  batches=0  totalClaims=0  totalCents=$0.00
  setAside: too_small 40 claims $1000.00
  says: "No MAC appeals to file."
```

`says` is the alert sentence. $1,000 is set aside, correctly counted in a field that is rendered
nowhere, and the one sentence that *is* rendered says there is nothing. Meanwhile one claim $40 short
is a job. The floor is a judgement about the worth of his time; "No MAC appeals to file" is a
statement about whether any exist, and where the two differ by a thousand dollars the sentence is the
thing that reaches him. Something like *"nothing worth filing today — $1,000.00 across 40 claims is
below the $30 floor"* costs a clause.

## The two costings in this module disagree, and only one can be right

The floor is priced per claim: *"Every Caremark submission needs a verification code typed by hand,
so that batch was 38 codes for two and a half dollars each."* `scripts/caremark-appeal-plan.ts`
supports that reading in detail — the form takes one Rx number, one 255-character comment and one
reason, so it is filled once per claim.

`worklist`'s own docstring prices it per batch:

> *"Batched by PBM because that is how they are filed — **one visit to one portal settles all of that
> payer's claims**."*

If the first is true the batching is a convenience and the floor belongs per claim, where it is. If
the second is true the cost is one code per visit, and forty claims at $25 is $1,000 for one code —
which his own reasoning ("thats not worth it") would accept rather than decline. The script is the
better evidence, so the docstring is probably the wrong half; but it is the sentence `Batch` is built
on, and one of the two should be corrected so the next person reasoning about the floor reasons from
the true one.

## Small

`too_small` is asked before `too_late` (line 342 against 424), deliberately — "the window gates cost
nothing to skip". The consequence is that the `too_small` total includes claims whose window has
already closed, so it is not "what we would recover if the floor came down". Worth a word wherever
that total is eventually shown.

## For session 1

1. **Is the MAC worklist meant to reach a page?** If it is, the floor, the verdicts and the set-aside
   total have an audience and everything above about the sentence applies. If the plan is that
   `appeals.ts` absorbs it, then `mac-appeal-candidates.ts` is a specification and should say so at
   the top, because today it reads as live.
2. **On the Caremark portal, does one submission carry one claim or many?** That decides which of
   the two costings in this module is the true one, and therefore whether $30 is per claim or per
   visit. Only somebody with the portal open can answer it.
