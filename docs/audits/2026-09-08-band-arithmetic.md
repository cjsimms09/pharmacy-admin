# Audit — the rebate ladder and band arithmetic (`ratio-effect.ts`, `band-strategy.ts`)

Helper A, 8 September. This is the module I said in the `shelf.ts` audit I had not traced. I have
now traced it. **Every formula in it is correct** — I re-derived each one — and the two findings are
not errors in the algebra but a missing bound and a gap that falls between two modules.

Reported that way round on purpose: the arithmetic here decides whether the pharmacy pays a premium
to chase a rebate band, and "I checked it and it is right" is worth saying explicitly when it is
true.

---

## Verified correct

**`counts()` against the three ratio definitions** (`drill-down.ts:10-16` states them):

| Definition | brand | generic | onestop generic | Correct? |
| --- | --- | --- | --- | --- |
| `generics_over_rx` (GCR) | denominator only | both | both | ✓ brand is in total Rx, not in generic |
| `onestop_over_rx` (OS/Rx) | denominator only | denominator only | both | ✓ numerator is OneStop alone |
| `onestop_over_generics` (OS/Gx) | neither | denominator only | both | ✓ brand is in neither |

**The spend needed to reach the next band.** Stated as `x = (tD − N) / (1 − t)`. Derived:
`(N+x)/(D+x) = t` → `N + x = tD + tx` → `x(1−t) = tD − N` → `x = (tD − N)/(1−t)`. ✓ Guarded on
`t < 1` so it cannot divide by zero, and floored at zero.

**Headroom before the band is lost.** Stated as "the denominator grows to N / t". Derived:
`N/(D+r) = t` → `r = N/t − D`. ✓ Guarded on `t > 0`, floored at zero, and `Infinity` handled.

**`withScrub`'s inversion.** Restating a drill-down position on the statement's scrub keeps the
numerator (the same generic purchases either way) and divides the denominator by
`statementPercent / drillDownPercent`. On the module's own example — 10.13% drill-down against
20.64% statement — the factor is 2.04, the denominator roughly halves and the ratio roughly doubles,
which is what the comment claims. ✓

**`bandAt`** takes the highest threshold reached and null below the lowest. ✓ Sorted before
scanning, so band order in the document does not matter.

**`positionCents`** derives the numerator from the ratio and the denominator rather than pretending
to know it, and `tierEffect` prices both bands on the *same* base so the difference isolates the
band. Both are the right call and both are documented as such.

---

## 1. `withScrub` will apply any factor, however implausible

**Severity: medium. Finding — a bound would be inventing a number, so this wants a decision.**

```ts
const factor = sameMonth.statementPercent / sameMonth.drillDownPercent;
const denominatorCents = Math.round(p.denominatorCents / factor);
```

Guarded against zero and against the wrong definition, and against nothing else. A drill-down GCR
read as 0.5% against a statement of 20% gives a factor of 40 — the restatement then asserts that
McKesson's scrub removes 97.5% of the denominator, and every band decision downstream runs on it.

The scrub is real and roughly halves the denominator on this pharmacy's figures. A factor of 40 is
not a scrub, it is a misread percentage on one of the two documents — and a misread percentage is
exactly what `drill-down.ts` warns about in its own header: *"a figure read into the wrong column is
a plausible percentage with a month beside it, and it selects a rebate band."*

**I did not add a bound**, because any threshold I picked would be a number nobody chose.
**Recommended instead:** carry the factor on the returned `Position` so a screen can say *"this
assumes the scrub removes 97% of the denominator"* — which is self-evidently wrong to a reader in a
way that a silent number is not. That is the same remedy this codebase uses everywhere else: say it
out loud rather than guess a cutoff.

**Query for session 1:**

```sql
-- Every month where both figures exist, and the factor each implies.
select d.month, d.gcr_percent as drill_down, s.scrubbed_gcr_percent as statement,
       round(s.scrubbed_gcr_percent / nullif(d.gcr_percent, 0), 2) as factor
from drill_down_months d join rebate_statements s on s.period_month = d.month
where d.gcr_percent > 0 and s.scrubbed_gcr_percent > 0;
```

(Adjust the table names to what the drill-down and statement rows are actually stored as.) A factor
that is stable near 2 across months is a real scrub. One that swings between months is a reading
problem, and the months it swings on are the ones to look at.

## 2. The band uplift on the spend that causes it is counted nowhere

**Severity: medium-high, and I want this checked rather than taken from me — it crosses two modules
and I cannot measure it.**

Two documented decisions, each sound on its own:

- `tierEffect` (`ratio-effect.ts`): *"the rebate a line earns on itself is the ordinary effective
  price (`effectiveMicros` in product-ledger.ts) and is not counted again here."* So `worthCents` is
  `base × (rate_next − rate_after)` — the band change on **existing** spend only. Correct, and it
  avoids double counting.
- `band-strategy.ts`: *"Effective means after the rebate **that line itself earns**."* And
  `effectiveMicros(gross, rebated, rate)` is handed the rate **currently** in force.

Put together, there is a gap. The marginal generic bought to lift the ratio earns the **new** band's
rate once the band is crossed — but it is priced at the **old** rate by `effectiveMicros`, and
`tierEffect` deliberately excludes it. Neither module is wrong; the money falls between them.

Worked through, with a base of $100,000 of contract generics, a current band of 20% and a next band
of 24% needing $10,000 more generic spend at the primary:

| | |
| --- | --- |
| What the site says the band is worth | `100,000 × (0.24 − 0.20)` = **$4,000** |
| Plus the new spend at the new rate, which nothing counts | `10,000 × 0.24` = **$2,400** |
| Priced by `effectiveMicros` at the old rate instead | `10,000 × 0.20` = $2,000 |
| **Uncounted** | **$400 on this example, and it scales with the spend needed** |

The direction is lost revenue: `nextTierNow` divides the band's worth by the spend it needs to get
"the premium at which moving that buying stops paying". An understated worth gives an understated
break-even premium, so the site tells the owner to decline a switch that would in fact pay. That is
precisely the decision he asked this feature for — *"if I am close to a higher tier and it's worth
$500, I might want to order generics from McKesson even if more expensive."*

**I have not changed it.** The fix is not obviously a one-liner: pricing the marginal line at the
prospective band rate makes a line's price depend on the whole order, which is a real design change
and could reintroduce the double count both modules are carefully avoiding. **The cleanest shape I
can see** is to leave `effectiveMicros` alone and have `next.worthCents` add the uplift on the spend
it is itself asking for — `base × (rate_next − rate_after) + x_contract × (rate_next − rate_after)`,
i.e. `(base + x_contract) × (rate_next − rate_after)` — since that is the same band change applied
to the same base the band will actually be paid on. But `x_contract` is the *contract* share of `x`,
which needs the split I could not settle in the secondary-payors audit either.

Please check my reasoning before acting on it.

---

## What I did not check

`band-strategy.ts` beyond its stated rules and how they use `ratio-effect`. Its two levers — brand
off the primary, generic on to it — each have a price per dollar and a supply, and I read the
argument without tracing the supply arithmetic. It deserves its own pass; I am not claiming to have
given it one.
