# The clipped NDC column: nine is asked about, ten is not — and one listed pack is taken for certainty

*12 September 2026 — session 2 (cloud). Audit of `86256fb`, "Stop calling two codes for one item a
disagreement, and read the NDC column's real length". Concerns `src/lib/invoice-lines.ts`
(`ndcFromRun`, `sameDrugCode`) and what those feed in `src/lib/over-nadac.ts`. **No file of session
1's is edited** — `invoice-lines.ts` is a reader of paper and mine to report on, not to change.*

## The commit is right, and the reasoning in it is the good kind

IPD's invoice 1008931 printed its NDC column clipped to nine digits on the propranolol line, the
same clipping that printed "PROPRANOLO" and "BUME" either side of it. `run.slice(-11)` made up the
missing two digits out of the item number, produced `54707560094` — nobody's code — put $3.99 of
purchases against nothing, and left the item number as `916` rather than IPD's `91654`.

`ndcFromRun` now **asks the directory how long the column was** rather than assuming. That is the
right move, and the restraint in it is right too: where two packs are listed under the product, the
nine digits are kept as nine rather than eleven with a pack size invented in them, because "a pack
size is what every cost-per-unit divides by". Verified against the code as written, with a stand-in
directory, all three of the commit's own cases come out as it says.

Two things are unfinished.

## One: the column can print ten, and ten is not asked about

`ndcFromRun` asks about eleven and about nine. The ten-digit NDC — the 4-4-2, 5-3-2 and 5-4-1 forms,
which is how a great many systems print an NDC natively and what a column clipped by one character
leaves — falls through to the same `run.slice(-11)` the commit was written to stop trusting.

Run against the function as it stands, with a directory holding `00093-0153-01` and
`41167-0587-07`:

```
TEN printed, 4-4-2 form of 00093-0153-01
  run=916540093015301
  code=40093015301   printed=11   itemNumber=9165   isADrug=false

TEN printed, 5-4-1 form of 41167-0587-07
  run=916544116705877
  code=44116705877   printed=11   itemNumber=9165   isADrug=false
```

That is the propranolol bug exactly, one digit over: a code belonging to nobody, purchases against
nothing, and the item number — the field you would reorder by — short of its last digit.

And it can be worse than loud. Guard 1 is `known(last11)`, so where the stolen digit happens to
complete a code the FDA does list, nothing is refused and nothing is counted as uncovered: the money
attaches, silently, to a drug that was not bought. That is the one case the commit itself names as a
real finding — "the one case where a system really does have the wrong drug against the money".

**The reader for it is already in this file.** `ndcFromUpc` pads ten digits back to eleven the three
ways an NDC can be padded and accepts the answer only when exactly one of them is a drug the
directory lists. Three lines. `ndcFromRun` does not call it.

Proposed, and run before proposing it — inserted after the nine-digit branches so nothing already
working is reordered:

```ts
// A ten-digit column, padded the three ways an NDC can be padded, accepted only when exactly one
// of them is a drug the FDA lists — the same closed question ndcFromUpc already asks.
const ten = run.slice(-10);
const padded = [...new Set(["0" + ten, ten.slice(0, 5) + "0" + ten.slice(5), ten.slice(0, 9) + "0" + ten.slice(9)])].filter(known);
if (padded.length === 1) return { code: padded[0], printed: 10 };
```

| case | today | with the three lines |
|---|---|---|
| eleven printed | `00093015301`, item `91654` | unchanged |
| nine printed, two packs — **the propranolol** | `707560094`, item `91654` | unchanged |
| nine printed, one pack | `00093015301`, item `91654` | unchanged |
| ten printed, 4-4-2 | `40093015301`, item `9165` | `00093015301`, item `91654` |
| ten printed, 5-4-1 | `44116705877`, item `9165` | `41167058707`, item `91654` |

Nothing that works today moves.

`sameDrugCode` has the matching hole: a nine-digit product matches an eleven-digit package of it,
but `sameDrugCode("00093015301", "0093015301")` is `false` — an eleven-digit code against its own
ten-digit form reads as a disagreement. The `ten()` helper inside that same function already
enumerates the three paddings; it is only ever applied to two eleven-digit codes.

## Two: one pack listed is treated as certainty, by the function that says the directory lags

The guards, in order:

```ts
if (packagesOf(last11.slice(0, 9)).length > 0) return { code: last11, printed: 11 };   // guard 2
…
if (packages.length === 1) return { code: packages[0], printed: 9 };                    // guard 3
```

Guard 2 exists **because the directory's package coverage lags** — its own words: "a package code
the directory has not caught up with is still that manufacturer's code and not a misread". Guard 3
then reads one listed package as proof that one package is all there is.

Those cannot both hold. If the pharmacy bought a pack the directory has not listed, guard 3 attaches
the line to the pack it *has* listed, and the eleven-digit code it returns was never printed on the
document. CLAUDE.md: *nothing is inferred where a document could say it* — here the document could
not, which is what makes guard 3 arguable at all; but `ndcFromUpc`'s discipline is the difference.
`ndcFromUpc` asks a **closed** question — which of exactly three arithmetic paddings is a drug —
and one answer settles it. Guard 3 asks an **open** one — is this the only pack that exists — and
treats a count of one as the same kind of answer. It is not.

**Where it lands.** The nine-digit code kept by the two-pack branch is inert: nothing joins to it.
`over-nadac-store.ts:40-42` builds pack quantities by exact NDC, `over-nadac.ts:108-112` drops any
line whose NDC has no pack size, and a nine-digit code has none. The eleven-digit code invented by
the one-pack branch is the opposite — fully live:

```ts
const packQty = input.packQtyOf(l.ndc11);           // over-nadac.ts:108
const gross = Math.round((l.packCostCents * 10_000) / a.packQty);   // :139
```

A hundred-count bought for $10, attached to the thirty-count because that is the only pack the
directory lists, divides by 30 instead of 100: 33.3¢ a tablet against a NADAC near 10¢, and the
drug appears more than 200% over NADAC. Over-NADAC rows are what the NADAC complaints are drawn
from. That is a letter to a state agency about a price nobody paid.

So the safer outcome — stay inert, attach to nothing — is reserved for the case where the directory
knows **more**, and the riskier one for the case where it knows least.

## What is actually wrong today: nothing

Said plainly, because it matters. Only one clipped line has been found, in 22 invoices, and two
packs are listed under `70756-094`, so it took the inert branch. Guard 3's one-pack case has not
fired on real paper that I can see, and I cannot see real paper. Both of these are about the next
clipped line, not this one. Neither is a reason to reopen anything that has settled.

## For session 1

Two questions only the pharmacy computer can answer:

1. Across the invoices held, does any line's NDC column print **ten** digits — `ndcFromRun`
   returning `printed: 11` for a `code` that `knownNdcs()` does not recognise is the flag.
2. How many stored invoice lines carry a code that came from guard 3's one-pack branch — an
   eleven-digit `ndc11` whose product has exactly one package listed, on an IPD or ParMed invoice?
   Each of those is a pack size the document did not print, now dividing a cost per unit.
