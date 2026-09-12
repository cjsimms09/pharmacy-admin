# "No basis on the claim" and "priced off AWP" share one verdict, and the site's own feed checker says the field is one the report cannot carry

**Audited:** `0f9397a` and `25f5b00` against `feature/compliance`. **By:** the cloud session (B).

`0f9397a` is a good fix and it came from the best possible source — Caremark rejecting the first
appeal this pharmacy filed, as *"non MAC claim"*. The gate it adds is the right gate, asked in the
right place (before the money questions), and its NCPDP mapping is correct: **06** and **07** are the
two MAC bases in field 522-FM, and 03 (AWP less a percentage), 08 (contract), 09 (acquisition) and 13
(WAC) all name a different benchmark. Treating an unrecognised code as not-MAC rather than unknown is
a defensible call and the commit states its reasoning.

One finding, and it turns on a factual premise three other parts of this repository contradict.

---

## The premise

`0f9397a`'s message:

> *"The plan has been answering that on every claim in field 522-FM, and
> `claims.basis_of_reimbursement` **has been storing it since the feed was written**. Nothing read
> it."*

`report-check.ts:69` — the module whose whole job is to say what the claims feed does and does not
carry — lists that field as **critical and absent**:

```ts
{ field: "basisOfReimbursement", name: "Basis of reimbursement", ncpdp: "522-FM",
  blocks: "Which pricing leg the PBM used is unknown, so an appeal cannot be aimed.", critical: true },
```

and `report-check.ts:174` puts it among the fields *"the report **cannot carry** (plan type, basis of
reimbursement, days supply)"*. `docs/reference/data-audit.md` §3 closes with the same statement: *"no
report carries the basis of reimbursement (NCPDP 522-FM), so the plan's pricing basis is inferred
from its payments (`pay-basis.ts`) instead of read."*

The importer does have the mapping (`claims.ts:51`, `:249`), so anything a report carries is stored.
**What none of us can settle from here is coverage**, and coverage decides everything: the gate
refuses on a null basis —

```ts
const basis = basisCode(c.basisOfReimbursement);
if (basis === null || !MAC_BASES.has(basis)) { … verdict: "not_mac_priced" … }
```

— so if the field is blank on most claims, a gate built to stop **one** bad appeal stops **every**
appeal, and the queue quietly goes to zero. The commit's own cost argument assumes blanks are rare:
*"skipping a real MAC claim costs one appeal worth a few dollars."* If blanks are common the cost is
the whole queue. The Rx 333968 example proves the field is populated **sometimes** — it carried 03 —
which makes partial coverage the likeliest and least visible case.

**This is the query for 1, and it is one line:** of claims filled since 1 September,
how many have `basis_of_reimbursement` non-null, and what is the distribution of its values? That
number says whether this gate is protecting the pharmacy or silencing it — and, either way, whether
`report-check.ts:69` and `data-audit.md` §3 are now stale and should be corrected, because
`report-check` is what tells the owner his feed is incomplete.

---

## The finding, which holds whatever the coverage turns out to be

The refusal **sentence** distinguishes the two cases, honestly and well:

> null: *"The claim does not say how the plan priced it, and an appeal needs a MAC to appeal
> against."*
> known non-MAC: *"The plan priced this off AWP less a percentage, not off a MAC list…"*

The **verdict does not**. Both are `not_mac_priced`, and `worklist` groups the set-aside by verdict,
keeping one representative sentence:

```ts
for (const j of judged.filter((x) => x.verdict !== "appeal")) {
  const e = aside.get(j.verdict) ?? { claims: 0, cents: 0, says: j.says };   // first claim's words
```

So the careful distinction is lost at exactly the point the owner reads it. One row says
`not_mac_priced — N claims, $X`, with whichever sentence happened to come first standing for all of
them. **The population that matters — "the claim does not say" — has no count of its own**, and it is
the one that is recoverable: those claims may well be MAC-priced, and the moment the feed carries
522-FM they become appealable. "Priced off AWP" is money that was never there; "we cannot tell" is
money waiting on a report writer.

**Fix:** a separate verdict — `basis_unknown` — beside `not_mac_priced`. Same refusal, same safe
default, no change to what is filed; it costs one line and it makes the set-aside say how much is
genuinely not appealable and how much is merely unreadable. That is also the number that would tell
the owner what fixing the PioneerRx report is worth, which is the question `report-check.ts` exists
to answer.

---

## Checked and sound

- **The NCPDP mapping is right.** 06 and 07 are the MAC bases; 03, 08, 09 and 13 name other
  benchmarks. An unrecognised code is quoted back rather than given an invented meaning, which is the
  same discipline `fdaPackageUnits` applies to a package it cannot read.
- **The gate is asked before the money questions**, so a non-MAC claim far below cost reports as
  non-MAC rather than as an appealable shortfall. That ordering is deliberate and correct.
- **`25f5b00`'s NADAC check is a genuinely good second gate**: a plan can return 06 or 07 and still
  have priced off the national average, and appealing one of those *"asks Caremark to reprice at
  NADAC a claim it already paid at NADAC."* The three-percent band is justified by NADAC's weekly
  publication rather than chosen for neatness.
- **Non-appeal claims are not silently dropped** — they reach `setAside` with a count and a total.
  The fault above is the grouping, not the visibility.

## For 1

1. `basis_unknown` as its own verdict. One line, and it sizes what the feed is costing.
2. The coverage query above — and if the field is well populated, correct `report-check.ts:69`
   and `data-audit.md` §3, which both still say the report cannot carry it.

Nothing in `mac-appeal-candidates.ts`, `mac-appeal-store.ts`, `report-check.ts` or `claims.ts` was
edited by me.
