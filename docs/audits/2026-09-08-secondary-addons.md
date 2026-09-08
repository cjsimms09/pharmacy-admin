# Audit — the secondary add-ons list (`minimum-filler.ts`, `usage.ts`, `order-plan.ts`)

Helper A, 8 September. The owner uses this list to find things worth adding to a secondary order to
reach its minimum. On the live data it offers nothing at any supplier. Session 1's facts: ANDA and
ParMed have no minimum on file, McKesson is the primary, and IPC and IPD each report **0 candidates
and 103 refusals, every refusal carrying the same sentence** — *"The rate is one large fill, not a
rate."*

**103 of 103 identical is not a filter reporting. It is a filter with nothing to say.** That is the
first finding, and it is why nobody could tell whether the rule or the data was at fault.

---

## 1. One sentence for three different tests, and it names the least likely one

**Severity: high — not because the arithmetic is wrong, but because it made the arithmetic
undiagnosable.** Fixed on this branch.

`usage.ts` decides steadiness on three separate conditions:

```ts
steady: a.dates.size >= STEADY.minActiveDays        // dispensed on ≥ 3 separate days
     && prescriptions >= STEADY.minPrescriptions    // by ≥ 2 separate prescriptions
     && concentration <= STEADY.maxConcentration    // no single fill > 60% of the volume
```

Three tests, one boolean. `order-plan.ts:502` printed one sentence for all three:

> "The rate is one large fill, not a rate."

That describes **the third test only**. On a thin archive the test that fails is almost always the
first or the second — *we have only seen this twice* — which is a different fact with a different
remedy. One says the demand is an outlier to be ignored. The other says there is not yet enough
history to judge it, and that the answer will change on its own as claims accumulate. A hundred and
three identical sentences hide that difference completely, which is why the list looks broken rather
than empty.

**Why the message could not have been right:** the three figures it would need — `activeDays`,
`prescriptions`, `concentration` — exist on `Velocity` and are **discarded at the `Movement`
boundary** (`order-plan.ts:90`), which carries only `steady: boolean`. The refusal was not being
lazy; it had nothing to be specific with.

**Fixed:** `whyNotSteady()` names the failed test with its own numbers, and `Movement` carries it
through. The first failure is reported, because the scarcest evidence is the honest thing to report.

**Query for session 1 — the one that settles rule-or-data:**

```sql
with w as (select julianday(max(date_filled)) - julianday(min(date_filled)) + 1 as days from claims),
d as (
  select ndc11,
         count(distinct date_filled) as active_days,
         count(distinct rx_number)   as prescriptions,
         max(quantity_thousandths) * 1.0 / nullif(sum(quantity_thousandths), 0) as concentration
  from claims where status = 'paid' and ndc11 is not null group by ndc11
)
select
  sum(case when active_days < 3 then 1 else 0 end)                                                   as fails_days,
  sum(case when active_days >= 3 and prescriptions < 2 then 1 else 0 end)                            as fails_scripts,
  sum(case when active_days >= 3 and prescriptions >= 2 and concentration > 0.6 then 1 else 0 end)   as fails_concentration,
  sum(case when active_days >= 3 and prescriptions >= 2 and concentration <= 0.6 then 1 else 0 end)  as steady,
  (select days from w) as window_days
from d;
```

**If `fails_days` is most of the 103, the rule is not wrong — the archive is short**, and the
thresholds want scaling to the window rather than loosening. **If `fails_concentration` is most of
it**, the original sentence was right and the rule is doing its job. Nobody can tell today, and that
is the whole point of the finding.

## 2. The thresholds are absolute where everything around them is a rate

**Severity: medium. Finding, not fixed — the query above decides it.**

`minActiveDays: 3` and `minPrescriptions: 2` are counts, not rates. Every other figure here is
divided by the window deliberately; `usage.ts` says so in its header: *"Every rate in the site
therefore shares a denominator, which is what makes two drugs comparable."* These two do not. Three
active days means something quite different across 30 days of claims than across 365, and the site
holds whatever has been imported.

The conservative direction is stated and correct — calling a lumpy drug steady fills a shelf with
money; calling a steady drug lumpy costs a discount. But that argues for a *strict* rule, not an
*unscaled* one, and on a short archive an unscaled rule refuses everything, which is what happened.

## 3. "Met by today's lines" answers a question the owner is not asking

**Severity: medium. Finding, not fixed — it is a product decision.**

`minimum-filler.ts:211`:

```ts
if (shortfallCents === 0) {
  out.push({ ...base, candidates, picks: [], addedCents: 0, ..., meets: true,
    says: `Today's lines of ${dollars(basketCents)} already meet the ${dollars(minimumCents)} minimum.` });
  continue;
}
```

`candidates` **is** carried through — nothing is hidden — but `picks` is empty and the sentence
closes the subject. The owner's question is not *"must I add anything to ship?"* but *"what else is
worth adding while I am placing this order?"* Those differ whenever the supplier is cheaper on
something the pharmacy will dispense anyway: reaching the minimum is the constraint, not the goal.

**Recommended:** when the minimum is met, keep the sentence and still offer the ranked candidates as
*"worth adding anyway"*, with the running total the owner asked for — he cannot see the cart, so the
total has to come from the page. Nothing to fix in the module; it already returns them.

## 4. No inventory count has ever arrived, so `daysOnHand` is usage-only — and the page does not say so

**Severity: medium. Finding.**

`Movement.onHandThousandths` is documented *"Zero where no count is held"*, and no on-hand file has
ever been imported. So every `daysOnHand` here is computed from a shelf of zero: it is *days until
the next patient needs it*, not *days of cover*.

That makes the ranking systematically urgent — `score()` weights `1 - daysOnHand / horizon`, and with
nothing on hand every item reads as running out today. Not wrong given what is known, and the safe
direction. But a pharmacist reading "2 days left" about a bottle on his shelf stops trusting the
column, and then the list.

**Recommended:** the page says once, plainly, that no count has been uploaded and every days-figure
assumes an empty shelf. True until the first count lands.

---

## What I checked and found sound

- **The ranking.** `score()` adds urgency (how far through the horizon the shelf is) to value (saving
  as a share of pack cost), so a line running out on Thursday leads, and between two running out
  together the cheaper-here one leads. That is the behaviour the owner described wanting.
- **The three gates before ranking** are the ones the comment claims: cheapest here after rebate, a
  whole pack inside the horizon, and a steady rate. No fourth undocumented gate.
- **Picks stop at the shortfall** rather than filling the basket, so the list does not talk the
  pharmacy into more than the minimum needs.
- **Refusals are kept and returned** rather than dropped — the only reason this audit was possible.
  The 103 were visible, and that is why the fault was findable at all.
