# The band guard's contract share: the fix, and a correction to how it was confirmed

8 September 2026 · Helper A · branch `work/shelf-band-share`

Session 1 asked me to propose the fix for shelf finding 2 — *"every secondary is 100% 'not
rebated', so the band guard is charging whole secondary baskets against the compliance ratio on
lines that never earned it"* — and said they would take it into `shelf.ts`. The proposal is below
as a tested pure function; `shelf.ts` is untouched.

**But the query that confirmed it read the wrong side of the join, and building the fix from its
answer would break the guard in the opposite direction.** That first.

## The correction

The query run was

```sql
select supplier, contract_flag, count(*) from supplier_items group by supplier, contract_flag;
```

and it came back with every secondary at 100% "not rebated". That is true and it is not this
question. `supplier_items.contract_flag` says whether a line sits on a purchasing contract **at the
supplier whose catalogue it came from** — the schema comment says so. A secondary's flags describe
the *secondary's* own programme, and secondaries mostly have none, which is exactly what 100% "not
rebated" is telling us.

The compliance ratio being protected is the **primary's**: generic Rx purchases through the primary
over total Rx purchases through the primary. What moves its numerator is whether the primary would
have invoiced that NDC as a contract generic. So the flag that decides `contractShareCents` is the
**primary's flag for the same NDC**, and the secondary's is irrelevant.

Read the secondary's flags instead and every basket's contract share is nought, `bandCostOfMoving`
returns no cost at all, the guard switches off, and orders go to secondaries even where a band
really is at stake. The guard exists because *"a $14 saving that drops a band can cost several
hundred, months later, on a report nobody connects to the decision"* — its own words. Turning it
off silently is a worse error than the conservative one it replaces, and it errs in the direction
nobody would notice.

**The query that answers it**, for the NDCs a secondary basket would actually contain:

```sql
-- What the primary's own catalogue says about the lines a secondary is cheaper on.
-- Replace 'mckesson' with the primary's name in `suppliers` where primary_supplier = 1.
select coalesce(p.contract_flag, '(no flag)') as primary_flag,
       count(*)                               as ndcs,
       sum(s.pack_cost_cents)                 as secondary_pack_cents
  from supplier_items s
  left join supplier_items p
         on p.ndc11 = s.ndc11
        and lower(trim(p.supplier)) = 'mckesson'
 where lower(trim(s.supplier)) <> 'mckesson'
   and s.unit_cost_micros is not null
   and (p.unit_cost_micros is null or s.unit_cost_micros < p.unit_cost_micros)
 group by 1 order by 2 desc;
```

Three numbers come out of that and each changes the recommendation:

- **`rebated`** — the share the guard should charge. If it is most of the basket the guard is
  roughly right today and finding 2 is small.
- **`not rebated`** — the share it is charging and must not. This is the overstatement.
- **`(no flag)` and the null join** — the share nobody can answer, which decides whether the fix
  below reports a figure or an upper bound.

## The fix

`src/lib/band-share.ts`, pure and tested (`tests/band-share.test.ts`, 8 tests). Two functions.

`contractShareAtPrimary(lines, primaryOffers)` splits a basket four ways against the **primary's**
catalogue, and values each line **at the primary's gross unit cost** — not the secondary's price and
not net of any rebate, because the ratio counts invoice dollars through the primary and using what
the basket actually paid would misstate the numerator by the whole saving:

| | |
| --- | --- |
| `contractCents` | the primary marks it a contract line — **this is the guard's input** |
| `nonContractCents` | the primary stocks it and does not mark it — cannot move the band |
| `unflaggedCents` | the primary stocks it with no flag — genuinely unknown |
| `notStockedCents` | the primary has no line for it — also unknown, and in the other direction |

`bandChargeFor(share)` turns that into what to charge, and is where the judgement sits. **The
unknown is included in the charge and declared.** Counting it as contract keeps the guard overruling
real savings; counting it as nothing stops it protecting a band that is at risk. Neither is
defensible as a silent default, so the guard stays conservative — the safe direction when the
downside is several hundred dollars months later — and the basket says out loud how much of its cost
rests on a flag nobody has:

> Between $10.00 and $40.00 of this basket would have counted toward the primary's ratio. The band
> cost below is priced on the higher figure, so it is the most this can cost and not what it will.
> Flagging the 75% the primary's catalogue does not answer would settle it.

`confident` is true only where every line was answered. That matters more than the arithmetic: where
it is false the fix is **a flag on the primary's catalogue**, not a better formula, and the page
should say so rather than dress a guess as a number.

## Where it goes in `shelf.ts`

The offers list is already built at line ~598 and carries the primary's flag per NDC, so nothing
new is read. At line 672:

```ts
const primaryName = suppliers.find((x) => x.primary)?.supplier;
// Built once, not per basket: the same list is walked for every one of them.
const primaryOffers = new Map(offers.filter((o) => o.supplier === primaryName).map((o) => [o.ndc11, o]));

for (const b of plan.baskets) {
  if (b.supplier === primaryName) continue;
  const share = contractShareAtPrimary(b.lines, primaryOffers);
  const charge = bandChargeFor(share);
  const cost = await bandCostOfMoving(b.subtotalCents, charge.chargeCents);
  if (!cost) continue;
  ...
}
```

`bandCostOfMoving` already takes `contractShareCents` as its second argument and already falls back
to the whole basket when it is absent, so nothing inside it changes. **Its fallback comment should
change**, though: it currently reasons that the whole basket is the pharmacy's actual case *"(a
secondary is cheaper on generics, not on brands)"*. That conflates "is a generic" with "is a
contract line at the primary", which is the same slip as the query above and is the reason the
fallback looked safe.

Two things to show on the basket where `confident` is false, so the recommendation is readable
rather than merely correct: `charge.says` beside the band cost, and the band cost itself labelled as
an upper bound rather than a figure.

## What I have not done

`shelf.ts` is untouched, as asked. And I would not merge the call until the query above is run: if
`rebated` turns out to be most of a typical basket, this changes few orders and the effort belongs
elsewhere; if `not rebated` is most of it, the guard has been flipping baskets back to the primary
that were genuinely cheaper away from it, and this is the difference between the order screen being
right and being safe.
