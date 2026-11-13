# The GPR question (Helper A, part d of the ratio-measure item)

**Asked:** the GPR ladder's `allGenericsPercent` is still null because only a monthly statement fills
`gprPercent`, while the daily drill-down already carries a generic share. Is it the same measure, and
should it be passed through?

**Answer: no, and it must not be passed through on my reading alone.** Here is the evidence, and the
query that would settle it properly.

## The drill-down carries three ratios, and none of them is GPR

`drill-down.ts:10-16` states its own definitions, and `DrillDownMonth` carries exactly these:

| Ratio | Definition, as the module states it |
| --- | --- |
| `gcrPercent` | generic Rx (excluding MPB) ÷ (total Rx − exclusions) |
| `osRxPercent` | OneStop ÷ total Rx |
| `osGxPercent` | OneStop ÷ total generic (Rx and OTC generics together) |

`gcrPercent` is the scrubbed generic compliance rate and is already used — it is what
`ratioSource: "daily report"` means. `osGxPercent` is the OneStop share of generics, a different
question with a different numerator. **GPR is parsed only from the statement**
(`rebate-report.ts:156`, `/^GPR:\s*([\d.]+)%/`) and appears nowhere in the drill-down.

Three ratios, three different denominators. Substituting any of them for GPR would select a band on
the wrong ladder — the denominator class of error SESSION-RULES §4 exists for, and a confident wrong
number of exactly the kind the drill-down module's own header warns about: *"a figure read into the
wrong column ... is a plausible percentage with a month beside it, and it selects a rebate band."*

## It could be computed — and that is the trap, not the answer

The drill-down does carry `totalGenericCents` and `netPurchasesCents`, so something GPR-shaped
(total generic ÷ net purchases) is derivable. Two reasons not to:

1. **McKesson's GPR denominator is not stated anywhere in this repository.** It might be net
   purchases, or net purchases less exclusions, or total Rx. The drill-down's own GCR line proves
   these denominators carry exclusions that are never printed — the module reconstructs them by
   implication and says so.
2. SESSION-RULES §4: *"Nothing is inferred where a document could say it."* A document says it. It
   is the monthly statement, and it has not been filed for the period in question.

Leaving `allGenericsPercent` null is the honest state: the site says no band can be chosen and names
the document that would settle it. That is the safe direction — an unstated rate understates the
pharmacy's position, where a guessed one overstates it and gets built into buying advice.

## The query that settles it empirically, which is better than either of us deciding

This repository's own method is to make the money reproduce the ratio (`rebate-report.ts:184`,
`drill-down.ts:90`). Apply it here:

```sql
-- For every month where a statement GPR and a drill-down month both exist, does
-- total generic ÷ net purchases reproduce the printed GPR?
select d.month,
       s.gpr_percent                                        as printed_gpr,
       round(d.total_generic_cents * 100.0 / d.net_purchases_cents, 2) as generic_over_net,
       round(d.total_generic_cents * 100.0 / d.total_rx_cents, 2)      as generic_over_rx
from drill_down_months d
join rebate_statements s on s.period_month = d.month
where s.gpr_percent is not null
  and d.net_purchases_cents > 0;
```

(Table and column names are from the schema as this session reads it; session 1 should adjust them
to whatever the drill-down and statement rows are actually stored as.)

**If `generic_over_net` reproduces the printed GPR to the hundredth across several months**, they are
the same measure, the drill-down can fill `gprPercent`, and the GPR ladder starts pricing the day a
drill-down lands rather than a month later. **If it does not reproduce**, the answer stays no and the
GPR ladder waits for its statement — and the site should keep saying so rather than guessing.

I have not made the change either way. One month agreeing would not be enough, and I cannot run the
query.
