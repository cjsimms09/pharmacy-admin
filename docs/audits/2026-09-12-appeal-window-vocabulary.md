# The appeal deadline gate matches one of the four values the contract extractor can write

**Audited:** `mac-appeal-candidates.ts` and `appeal-packet.ts`, the last of the queue, while the base
was quiet at `1a8554f`. **By:** the cloud session (B). **Method:** `judge` run against every value
the extractor's own schema permits.

`mac-appeal-candidates.ts` is right about the thing that matters most — a MAC appeal does not need
the contracted rate, only what the drug cost and what was paid, which is what every PBM form asks —
and right to refuse to compute a deadline from a date that does not mean what the contract meant:

> *"Where a contract says something else entirely the window stays null rather than being computed
> from a date that does not mean what the contract meant."*

That caution is correct and nothing below argues with it. The fault is that the gate and the
extractor do not speak the same language, so the caution fires almost always.

---

## The two vocabularies

```ts
// mac-appeal-candidates.ts:112 — what the gate accepts
const STARTS_AT_FILL = new Set(["initial_claim", "adjudication", "date_of_service", "date_of_fill"]);

// contract-terms.ts:344 — what can actually be stored
macAppealWindowBasis: z.enum(["date_of_fill", "date_of_adjudication", "date_of_remittance", "unknown"])
```

The intersection is **`date_of_fill` alone**. Three of the four names the gate looks for —
`initial_claim`, `adjudication`, `date_of_service` — **cannot be produced by anything that writes this
field**. They are the words the contracts use, quoted in the docstring, and not the values the schema
stores.

Run, with a ten-day window on the contract and a claim eleven days old:

| `windowBasis` | verdict | deadline | what the owner is told |
| --- | --- | --- | --- |
| *(no window at all)* | appeal | null | "names no filing deadline, so there is no clock" — **true** |
| `date_of_fill` | too_late | 2026-09-11 | "allows 10 days from the fill and that ran out on 2026-09-11" — **true** |
| **`date_of_adjudication`** | appeal | null | "**names no filing deadline, so there is no clock**" — **false** |
| **`date_of_remittance`** | appeal | null | "**names no filing deadline, so there is no clock**" — **false** |
| **`unknown`** | appeal | null | "names no filing deadline" — wrong words for "we do not know" |
| **`null`** (not transcribed) | appeal | null | "**names no filing deadline, so there is no clock**" — **false** |

The contract names ten days. The site says there is no deadline, with the number sitting in
`appealWindowDays` as it says it.

**And the priority follows the false reason.** `worklist` sorts by deadline and puts a batch with no
clock last, on the stated grounds that *"nothing is lost by waiting"*. For a payer whose window runs
from adjudication, something is lost by waiting, and these are the batches pushed to the bottom.

**The codebase's own worked example lands in the broken branch.** `contract-extract.ts:532` —
the sample extracted appeal term — writes `macAppealWindowBasis: "date_of_adjudication"`.

---

## And the site already has a reader that gets this right

`appeal-packet.ts:79` reads the same field with the extractor's vocabulary, and handles the case the
other one cannot:

```ts
const basis = terms.windowBasis ?? "date_of_fill";
const from = basis === "date_of_adjudication" ? claim.adjudicatedOn ?? null
           : basis === "date_of_remittance"   ? claim.remittedOn ?? null
           : claim.dateFilled;
if (!from) return { deadline: null, basis: `The window runs from the ${…}, which the site does not hold for this claim.` };
```

So the two readers of one field disagree three ways: on a null basis (`deadlineFor` computes from the
fill, `judge` says no clock), on adjudication, and on remittance. And `deadlineFor` already says the
true sentence for the case where the anchor date is missing — *"the window runs from the date of
adjudication, which the site does not hold for this claim"* — which is exactly what the worklist
should be saying instead of "there is no clock".

**Fix:** give `judge` the extractor's vocabulary and `deadlineFor`'s shape. Where the basis is
adjudication or remittance and the claim carries that date, compute from it; where it does not, keep
the claim in the list and say the window exists but its start is not held — distinguishing "no
deadline" from "a deadline I cannot anchor", which is the distinction the docstring already draws in
prose. Better still, have one of them call the other: two readers of one contract field is the fault
this repository keeps finding.

---

## Checked and sound

- **The window is inclusive of its last day.** `daysLeft < 0` is too late, so filing on the deadline
  itself is allowed. That is the generous reading and the right one here: the cost of being a day
  strict is a claim silently dropped as expired.
- **`whoFiles`, the brand/generic gate, and the already-filed gate are applied before the window**,
  so a claim is never reported as out of time when the real answer is that the PSAO files it.
- **"Unknown is not the same as expired" is honoured** — an unreadable window returns `appeal`, not
  `too_late`. The money is never dropped; only its urgency is misstated.

## For 1

1. One vocabulary for `windowBasis`, and one reader. The finding above.

**Question under "Open items":** across the agreements read so far, how many PBMs have
`appeal_window_days` set with a `window_basis` that is not `date_of_fill`? That is the number of
payers currently being told they have no deadline.

Nothing in `mac-appeal-candidates.ts`, `appeal-packet.ts`, `contract-terms.ts` or
`contract-extract.ts` was edited by me.
