# A paid row with no NDC falls out of both answers

**Audited:** `c041d1a`…`521dd79` (nine commits) against `feature/compliance`. **By:** the cloud
session (B). **Method:** the modules run.

A large push. I audited the two commits that move money rather than skimming all nine:
`52e4d67` (takes revenue **off** the books) and `41eb512` (decides when promised money is late).
One finding, not live; the rest of what I checked is sound and is recorded so it is not re-derived.

---

## The finding: `staleAgainstDispensing` returns two lists and a live row can be in neither

`52e4d67` is careful work and the direction is the dangerous one — it reverses live claims, removing
$192.48 of accrual net. Its three guards are exactly right and all three are really in the code:

```ts
if (!truth || truth.size === 0 || live.length === 0) { keep.push(...live); continue; }   // PioneerRx must have an opinion
const contradicted = live.filter((r) => r.ndc11 !== null && !truth.has(r.ndc11));        // a different NDC, affirmatively
if (confirmed.length === 0) { keep.push(...live); continue; }                            // never the last live row
```

And the one assumption that could have made the whole test wrong — a fill genuinely dispensed as two
NDCs — was **measured, not assumed**: 2,546 valid claim rows over 2,484 September fills, no fill
carrying more than one NDC. That is the right discipline.

**The gap is in the accounting of rows rather than in any guard.** `confirmed` and `contradicted`
both require `r.ndc11 !== null`, so a live paid row carrying **no NDC** is in neither, and the
function pushes only `confirmed` into `keep`. Run, on one fill with all three shapes:

```
input live rows : confirmed, contradicted, no-ndc
keep            : confirmed
stale           : contradicted
in NEITHER list : no-ndc
```

**It is not live, and I want that said first.** The only caller takes `stale` alone —
`const { stale } = staleAgainstDispensing(held, dispensed);` (`claims.ts:1780`) — so the null-NDC row
is simply not reversed, which is the correct outcome. No revenue is wrongly removed today.

**What makes it worth a line anyway** is that `keep` is not dead: four assertions in
`tests/stale-fills.test.ts` read it as the set of rows that survive (`r.keep.map((k) => k.id)`,
`r.keep.length`). So it is a tested part of the contract, and the natural next use of this module —
writing back the surviving set, or counting it for the register — would drop a paid row that nobody
decided about. In a module built because *"occurrence #2 stands as live revenue for ever"* when
nothing looked at it, a row falling out of both answers is the same shape as the bug being fixed.

**Fix, one line:** keep the unjudgeable rows explicitly —

```ts
keep.push(...confirmed, ...live.filter((r) => r.ndc11 === null));
```

A null NDC means *cannot be judged*, and this module's own principle is that "we have not been told"
must never become an action. Here that means the row is kept, not quietly dropped from the count.

---

## Checked and sound

**`41eb512` does not change what is owed, which is the thing worth checking about it.** Its docstring
promises *"Nothing here changes what is owed… the whole outstanding figure stays on the screen."*
Verified at the consumer (`money-position.ts:301-304`):

```ts
promisedCents: promised.reduce((n, f) => n + (f.facilitatorOutstandingCents ?? 0), 0),   // the full sum, untouched
promisedDueCents: promisedSplit.dueCents,
promisedNotDueCents: promisedSplit.notDueCents,
```

The split is reported **alongside** the total, not instead of it. Money inside the payer's cycle
stops being a job and does not stop being owed — which is the distinction the commit set out to draw.

**The four states are kept genuinely apart**, and the module says why: `expectedFacilitatorCents ===
null` (nobody promised) and `facilitatorOutstandingCents === 0` (promised and paid) are both
"nothing outstanding", and collapsing them would make a fill nobody owes anything on look like one a
payer settled. That is `docs/DAILY-CHECK.md`'s "a null that means two things", caught before it
landed.

**Keying the grace on the facilitator rather than the adjudicating PBM is right.** The BIN on the
claim is Caremark or OptumRx, and none of them pays the MTF promise — holding the facilitator to the
cycle of somebody who is not paying would be a made-up deadline.

## For 1

1. Keep the unjudgeable rows in `keep`. One line, and nothing behaves differently today.

Nothing in `claims.ts`, `promise-due.ts` or `money-position.ts` was edited by me.
