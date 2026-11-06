# Audit — product identity from the FDA directory (commit `1c8591d`)

Helper A, 8 September. Read against `docs/reference/buying-logic.md`, `data-dictionary.md` and the
doctrine stated in `product-groups.ts` itself. No database was reachable from this session, so every
finding below is read from the arithmetic and demonstrated by running the pure function. **Each one
carries the query session 1 should run to size it.**

The change is right, and the measurement behind it (10,427 NDCs wrongly merged on NADAC's
description) is the kind of evidence this repository should be built on. Three defects survive it.

---

## 1. The brand/generic guard is silently lost for every FDA-keyed NDC that has no NADAC row

**Severity: high. This is a wrong merge, which is the direction `product-groups.ts` says must never
happen.**

`groupKey` builds `fda:<key>|<classification>|<unit>|<RX|OTC>`. The classification is NADAC's, and
it is the *only* thing keeping a brand apart from its generic — the commit message says so itself:
*"A brand and its generic share an FDA equivalence key by definition."*

Where the directory places an NDC but NADAC has no row for it, `classification` is null and becomes
`?`. It becomes `?` for **every** such NDC. So a brand and its generic, which the FDA gives the same
equivalence key, both key to `fda:<key>|?|?|RX` — one product.

Run against the pure function on this branch:

```
fda:amlodipine-10-tab-oral|B|EA|RX   brandWithNadac
fda:amlodipine-10-tab-oral|G|EA|RX   genericWithNadac
fda:amlodipine-10-tab-oral|?|?|RX    brandNoNadac, genericNoNadac   ← one group
```

The two call sites that reach this deliberately are `drug-profit-store.ts:174` and
`money-found.ts:146`, both passing `description: null, classification: null, pricingUnit: null` for
NDCs the directory places and NADAC does not. That was the intended improvement — an NDC no longer
needs a NADAC row to be grouped — and it is where the guard goes.

Why it costs money: `drug-profit-store` answers "which NDC in this product pays best" and
`money-found` looks for money left on the table. A group containing both a brand and its generic
will name one as the better buy against the other. That is a DAW decision belonging to the
pharmacist and the plan, and it cannot be dispensed on a price comparison.

The commit puts the FDA directory at 77.5% of the catalogue and NADAC at 57.3%, so the affected band
is roughly a fifth of the catalogue — but the number that matters is how many of those groups
actually contain both a brand and a generic.

**Query for session 1:**

```sql
-- How many FDA-keyed groups with no NADAC row hold more than one marketing category —
-- i.e. how many brand/generic merges this has actually created.
select count(*) from (
  select d.equivalence_key,
         count(distinct case when d.marketing_category like '%NDA%'
                             and d.marketing_category not like '%ANDA%' then 'brand'
                             else 'generic' end) as kinds
  from drug_directory d
  join supplier_items s on s.ndc11 = d.ndc11
  left join nadac_prices n on n.ndc11 = d.ndc11
  where n.ndc11 is null
  group by d.equivalence_key
  having kinds > 1
);
```

**The fix is one column away and already loaded.** `drug_directory` carries `brand_name` and
`marketing_category` (`schema.ts:2929`, `2937`) — `NDA` and `NDA AUTHORIZED GENERIC` against `ANDA`
is exactly the brand/generic distinction, from the FDA rather than from NADAC. Where NADAC has no
classification, the directory's own answer should stand in rather than `?`. I have not made that
change: it alters grouping semantics for a fifth of the catalogue and the measurement above should
decide it, not my reading. Session 1's call.

## 2. The same NDC gets a different group key in `replay-store` than in the other three stores

**Severity: medium. Two grouping rules again, which is the thing this commit set out to end.**

`groupKey` takes `otc` and appends `OTC` or `RX`. Of the four stores the commit unified:

| Store | passes `otc`? |
| --- | --- |
| `replay-store.ts:64` | yes |
| `drug-profit-store.ts:112` | **no** |
| `products-store.ts:27` | **no** |
| `money-found.ts:139` | **no** |

The three that omit it get `undefined`, so every NDC keys as `RX`. `nadacNow()` returns `otc` and
the row is in scope at all three call sites (`nadac-latest.ts:69`) — it is simply not passed.

Two consequences. An OTC product and its prescription counterpart merge into one group in three
stores out of four — and `product-groups.ts` says an OTC row *"is reimbursed differently or not at
all"*, so that is a second wrong merge. And a group formed in `replay-store` cannot be reconciled
with the same product in `products-store`, because the keys differ by construction. The commit's
claim of *"one grouping rule now, where there were two"* does not hold across all four.

This one I am sure of, and it is fixed in the second commit of this pull request, marked as a fix.

**Query for session 1, to size what it was doing before the fix:**

```sql
select count(*) from nadac_prices where otc = 1;
select count(distinct n.ndc11) from nadac_prices n
  join supplier_items s on s.ndc11 = n.ndc11 where n.otc = 1;
```

## 3. A product is split by whether NADAC covers each NDC, not only by scheme

**Severity: low — it costs comparisons rather than causing a wrong one. Worth knowing the size of.**

The commit accepts one split knowingly: an NDC keyed by the FDA and one keyed by description form
two groups. Correct, and the safe direction.

There is a second split it does not mention. Two NDCs that *both* have FDA keys still separate when
one has a NADAC row and the other does not, because the first keys `|G|EA|` and the second `|?|?|`.
So a product does not merely split across the two schemes — it splits along NADAC coverage inside
the FDA scheme.

Nothing is wrongly merged by this, so it is not dangerous. But the assignment asks whether an NDC
with an FDA key and no NADAC row can fall out of a group: it does not fall out, it forms a *separate*
group from its own siblings. On a two-NDC product where NADAC covers one, the result is two groups
of one and no comparison at all — the case the change was meant to fix.

Fixing finding 1 with the directory's own classification would close most of this at the same time.

**Query for session 1:**

```sql
-- Products where the FDA agrees the NDCs are one thing but NADAC coverage splits them.
select count(*) from (
  select d.equivalence_key
  from drug_directory d
  join supplier_items s on s.ndc11 = d.ndc11
  left join nadac_prices n on n.ndc11 = d.ndc11
  group by d.equivalence_key
  having count(distinct case when n.ndc11 is null then 0 else 1 end) > 1
);
```

---

## What I checked and found sound

- **Every store now passes the FDA key.** All four call `groupKey` with
  `directory.get(ndc)?.key ?? null`. The `groupResolver` path that returned a bare `fda:<key>` and
  dropped classification, unit and OTC is gone from `drug-profit-store`.
- **The two schemes are never mixed or compared.** The `fda:` prefix keeps them apart even if a
  description key ever spelled the same string, and `groupKey` chooses one or the other, never both.
- **A product split across the two schemes cannot recommend a switch.** A switch is only ever
  offered inside a group, and split NDCs are in different groups. The safe direction, as claimed.
- **`groupProducts` places an NDC once**, on its first row, so a later NADAC row with a different
  description cannot move it between weeks.
- **The placeholder refusal is now on both paths.** `isPlaceholderRow` is asked by the catalogue
  importers and by NADAC, and migration `0082` clears the nine McKesson rows already stored. Those
  were priced $110.25 a unit against a pack of one and flagged "not rebated" — the flag the buy list
  reads as a reason to source elsewhere — so they were actively steering purchasing.
