# Resolved: the appeal scripts' own pack divisor. And the boundary of the fix.

*12 September 2026 — session 2 (cloud). `src/lib/pack-size.ts` (new in `73ddade`) checked by running
it. **Closes an open finding of mine.** No file of session 1's is edited.*

## The finding, and why it is closed

My open finding was that the three MAC appeal scripts each derived a pack size themselves, with a
regex taking the **outer** count off `drug_directory.package_description` — a count of cartons or
blisters as often as of anything dispensed. It was marked LIVE and worst-of-list because an evidence
PDF divides a package price by it and goes to a PBM under the pharmacy's NPI.

`73ddade` replaces all three with one `packForClaim` from `pack-size.ts`:

```
scripts/caremark-appeal-plan.ts:54      const { packForClaim } = await import("../src/lib/pack-size");
scripts/mac-appeal-evidence-one.ts:22   const { packForClaim } = await import("../src/lib/pack-size");
scripts/mac-appeal-evidence-pdfs.ts:23  const { packForClaim } = await import("../src/lib/pack-size");
```

and `mac-appeal-evidence.ts:44` now takes a `PackSize` carrying its unit with its number, so the
divisor and the unit cannot separate.

Run against the three cases the module's own docstring names, with the FDA dosage form supplied:

```
Wegovy — 4 pens of 0.5 mL
  pack = 2 ML     claimQuantityAgrees {"agrees":true,"packages":1,"exact":true}
  $100.00 a package -> $50.0000 per unit      old outer-count reading: 4 -> $25.0000

Estradiol vaginal cream — 42.5 g tube
  pack = 42.5 GM  claimQuantityAgrees {"agrees":true,"packages":1,"exact":true}
  $100.00 a package -> $2.3529 per unit       old outer-count reading: 1 -> $100.0000

Plain bottle of 100 tablets
  pack = 100 EA   claimQuantityAgrees {"agrees":true,"packages":1,"exact":true}
  $100.00 a package -> $1.0000 per unit       old outer-count reading: 100 -> $1.0000
```

All three right, the ordinary case unchanged, and the two that were wrong now agree with the claim's
own quantity exactly. **The finding is closed.**

It also refuses rather than guesses: with the dosage form blank, all three come back
*"The FDA dosage form '(blank)' is not one this can say a billing unit for, so how many units are in
the pack cannot be settled."* That is the right failure and it is worth recording, because a divisor
that guesses is how the original fault happened.

The fourth re-derivation the docstring mentions is not a fourth fault: `drug-directory.ts:416`'s
`packageUnits` delegates to `fdaPackageUnits`, the properly-nested reader, and answers a different
question correctly.

## The boundary, so nobody assumes this reached further than it did

**This does not touch the over-NADAC divisor**, and my separate finding there still stands.
`over-nadac-store.ts:40-42` builds pack quantities from the **catalogue's** `packSize` via
`packQtyOf`, not from the FDA:

```ts
for (const c of catalogue) { const q = packQtyOf(c.packSize); if (q && q > 0 && !packOf.has(c.ndc11)) packOf.set(c.ndc11, q); }
...
const gross = Math.round((l.packCostCents * 10_000) / a.packQty);   // over-nadac.ts:139
```

So the open finding about `ndcFromRun`'s one-pack branch inventing an eleven-digit package code is
unaffected by `pack-size.ts`: the code it invents keys a catalogue pack quantity, and a wrong package
code still picks a wrong divisor there. Different source, same shape, still open — see
`docs/audits/2026-09-12-the-column-that-printed-ten.md`.

Whether the over-NADAC path should also take its divisor from `pack-size.ts` is a design question and
session 1's, not a finding: the catalogue's pack size is what the pharmacy is actually billed for,
which is a defensible reason to prefer it.
