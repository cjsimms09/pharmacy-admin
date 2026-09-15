# The appeal evidence page reads a pack size with a regex that stops at the outer carton

**Audited:** `011b91d`…`893aefd` (four commits, all MAC appeals) against `feature/compliance`.
**By:** the cloud session (B). **Method:** both parsers run against the FDA's own documented shapes.

`382b190` is right about the problem and right about the remedy: one page stating the case, not nine
pages handing a PBM the pharmacy's whole acquisition cost list and its Schedule II purchasing.
`mac-appeal-evidence.ts` shows its working, names the pack size's source, and writes the division
out, for the reason its own docstring gives:

> *"Divide by the wrong number and a methylphenidate tablet costs $245.98 instead of $2.46 — which
> is what a first attempt at this produced, and **it would have gone to a PBM under the pharmacy's
> name with its NPI on it**."*

That is exactly the failure below, reintroduced one file away.

---

## 1. The pack size comes from a local regex, not from the tested reader

`scripts/mac-appeal-evidence-one.ts:15` and `scripts/mac-appeal-evidence-pdfs.ts:16` each define
their own:

```ts
function packUnits(desc: string | null): number | null {
  if (!desc) return null;
  const m = /^\s*([\d.]+)\s+[A-Z]/i.exec(desc);      // the FIRST number, and nothing else
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
```

`desc` is `drug_directory.package_description` — the FDA's own field, which is a **nest**, outermost
first, levels joined by `/`. This regex reads the outermost level and stops. The site already has
the reader for it, `fdaPackageUnits` in `data-health-packages.ts`, which multiplies the levels out,
refuses a description that stops at a container, and refuses a kit.

Both run against the shapes the tested reader's own suite uses:

| package description | `fdaPackageUnits` | the scripts | effect on the stated cost |
| --- | --- | --- | --- |
| `100 CAPSULE, DELAYED RELEASE in 1 BOTTLE (0093-0073-01)` | 100 EA | 100 | correct |
| `3 BLISTER PACK in 1 CARTON (…) / 28 TABLET in 1 BLISTER PACK` | **84 EA** | **3** | **28× too high** |
| `1 BOTTLE in 1 CARTON (…) / 30 mL in 1 BOTTLE` | **30 ML** | **1** | **30× too high** |
| `3 BLISTER PACK in 1 CARTON (…)` | **REFUSED** | **3** | a number where the FDA gives none |
| `1 KIT in 1 CARTON (…) * 1 TABLET in 1 BLISTER PACK` | **REFUSED** | **1** | a number where the FDA gives none |

The ordinary single-level package — which is most of them — is read correctly, and that is why this
would not show up in a spot check. The failures are confined to nested, container-only and kit
descriptions, and every one of them fails **silently and in the direction that overstates the
pharmacy's cost**.

**Overstating is the worse direction.** The page asks a PBM to reimburse *"acquisition cost … plus a
dispensing fee"*. Overstate the cost and the pharmacy asks, in writing, under its own NPI, for more
than it is owed. `fdaPackageUnits`'s own docstring gives the rule this breaks: *"Returns null rather
than a guess where the field is not this shape: an invented package is worse than an absent one,
because the whole point of this is to be the party nobody argues with."*

**It is live.** `893aefd` records a finding that *"came out of filing appeals"*, so appeals are being
produced by these scripts now. And this is the third time this class of error has been caught here:
`docs/HANDOFF.md` still carries the 9 September case where an appeal stated an acquisition cost five
times what was paid, because `packQtyOf` dropped a bracket.

**Fix:** delete both local `packUnits` and call `fdaPackageUnits`. It returns `{ units, uom }`, so it
also replaces the second guess below, and a `{ ok: false, why }` gives the skip line a real reason
instead of *"no pack size"*.

### The unit label is sniffed from the same string

`scripts/mac-appeal-evidence-pdfs.ts:59`:

```ts
const unitLabel = /\bML\b|MILLILITER/i.test(String(a.pkg)) ? "Milliliter" : "Each";
```

It happens to agree with `fdaPackageUnits`'s `uom` on all five rows above, because the word `mL`
appears only where the measure really is millilitres. It is a substring test on a whole nest, so it
will disagree the first time a tablet's description mentions a millilitre at any level — and the
label is printed three times on the page, including in the per-unit figure the reviewer checks.
`uom` is already computed by the reader this should be calling.

---

## 2. `buildEvidence` divides by a pack size it never checks

```ts
const costPerUnitCents = inv.packPriceCents / inv.packUnits;
```

No guard. Run:

| `packUnits` | printed |
| --- | --- |
| 100 | `$245.98 / 100 = $2.4598 per each` |
| **0** | `$245.98 / 0 = $Infinity per each` … `Acquisition cost: $Infinity` |
| **null** | `$245.98 / null = $Infinity per each` … `Reimbursement of $Infinity` |

and `quantity: 0` gives `$Infinity per each` in the closing ask.

**Not live, and I want that said plainly.** Both current callers refuse null before calling
(`mac-appeal-evidence-one.ts:50` throws, `mac-appeal-evidence-pdfs.ts:54` skips), and their
`packUnits` cannot return 0 because of its own `n > 0`. So no `$Infinity` page can be produced
today.

It is worth fixing anyway, because the guard is in two copies in two scripts and absent from the
pure module that is supposed to own the rule — which is precisely how finding 1 happened. A third
caller that forgets it gets a page reading `$Infinity` addressed to a PBM. The module is pure and
tested; its contract should be total. Refuse a non-finite or non-positive divisor and say so.

---

## Checked and cleared

- **The arithmetic that *is* shown is sound.** `$245.98 / 100 = $2.4598`, then
  `$2.4598 × 30 = $73.79`, and a reviewer recomputing from the printed figures gets the printed
  answer. The four-decimal per-unit figure is right for a tablet costing a third of a cent, and the
  rounding is applied once, at the end.
- **`drug-directory.ts:416`'s docstring writes the nest with `>` where the data and the parser use
  `/`** (`data-health-packages.ts:113`). It cost me a wrong conclusion, which I checked against the
  fixture and the tests before reporting anything — `fixtures/fda-ndc-package.txt` and
  `tests/data-health-packages.test.ts` both settle it as `/`. Worth a one-character correction; the
  code is right.
- **The scope disclaimer at the foot of the page is correct and should stay.** It evidences a cost
  and names a shortfall without asserting a statutory entitlement, on the grounds that the Kansas
  floor under SB 20 reaches only plans outside ERISA preemption and which of this pharmacy's plans
  those are has not been established. That is the right reading of what SB 20 does, and claiming a
  floor that does not apply is how a pharmacy's appeals stop being read.

## For 1

1. Both scripts to call `fdaPackageUnits` and take `units` and `uom` from it. Finding 1 — it is
   going to PBMs now.
2. A divisor guard in `buildEvidence`. Finding 2, not live, one line.

Nothing in `mac-appeal-evidence.ts`, the appeal scripts, `drug-directory.ts` or
`data-health-packages.ts` was edited by me.
