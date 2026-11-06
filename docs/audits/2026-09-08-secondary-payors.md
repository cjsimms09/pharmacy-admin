# Audit — profit asserted to one payor (claims with a secondary)

Helper A, 8 September. The owner: *"I've noticed we tend to assert all the profit to one payor which
doesn't make sense."* He is right, and it is wrong twice on the same 22 fills, in opposite
directions, from the same mistake.

Numbers from session 1's measurement: 22 of 1,054 insured paid fills carry more than one payor
(2.1%), $8,456.07 of remit between them.

---

## The mistake, stated once

**Attributing a whole fill to one payor.** A coordinated prescription is one bottle, bought once,
billed twice. Any figure that puts the bottle on one of the two transmissions is describing
something that did not happen.

## 1. PioneerRx's printed gross profit puts the whole cost on the primary

Its per-row figure gives the primary the entire acquisition cost and the secondary none. On this
pharmacy's rows:

| BIN | rows | remit | acquisition | printed gross profit |
| --- | --- | --- | --- | --- |
| 610011 | 4 | $462.50 | $1,306.23 | **−$843.73** |
| 024284 (RxRescue) | 5 | $458.29 | $0.00 | **+$458.29** |
| 610524 | 5 | $245.81 | $0.00 | +$265.81 |

The primary reads as a disaster and the secondary as pure profit. Neither describes anything. Any
page summing the export's own profit column by payor inherits it exactly.

`fills.ts` already refuses this at the fill level and says so in its header, and session 1 confirmed
it holds on the data: on all 22, acquisition sits on exactly one row. **The fill layer is sound.**

## 2. The site makes the opposite error, from the same cause — `payer-map.ts`

**Severity: high. It is the ranking the owner reads to decide who pays well.**

`payer-map.ts:127`:

```ts
const payerKey = (f: Fill): { key: string; bin: string | null } => {
  const p = f.payers[0];
  return { key: p.name ?? p.bin ?? "unnamed", bin: p.bin };
};
```

Every fill is keyed on `payers[0]` — the primary — and then the **whole fill** is added to it:

```ts
e.revenueCents += f.revenueCents;   // every payor's remit, plus the patient's money
e.costCents    += f.acquisitionCents ?? 0;
e.marginCents  += f.marginCents;
```

Two consequences:

- **The primary is credited with the secondary's remit as its own revenue.** On the 22 fills, the
  primary's "revenue" includes money a different company paid. Its margin per fill is flattered, and
  it rises in "Paying best" on the strength of it.
- **A payor that only ever appears second does not exist.** It has no row in the table at all. If
  RxRescue is always a top-off, the site has never scored it — while `TOP_OFF_BINS` shows somebody
  already noticed the shape for subsidy cards specifically (`cardSupportBesideThisCents` holds their
  money apart). A *non-subsidy* secondary gets neither that treatment nor a row.

Working over fills rather than rows is right and the header defends it correctly. Keying the fill on
one payor is the part that does not follow.

**Query for session 1, to size it:**

```sql
-- How much remit sits on secondary rows, and so is currently credited to a primary.
with fills as (
  select rx_number, fill_number, date_filled, ndc11, count(distinct bin) as payors
  from claims where status = 'paid' and (cash_plan is null or cash_plan = 0)
  group by rx_number, fill_number, date_filled, ndc11
)
select c.bin, count(*) as rows_, sum(c.remit_cents) as remit_cents
from claims c join fills f
  on f.rx_number = c.rx_number and f.fill_number = c.fill_number
 and f.date_filled = c.date_filled and f.ndc11 is not distinct from c.ndc11
where f.payors > 1 and c.status = 'paid'
group by c.bin order by remit_cents desc;
```

Any BIN in that list which does **not** appear in the payer scores is a payor the site has never
measured. Any that does appear is a payor whose score contains other companies' money.

## 3. `payer-tree.ts` is sound — and shows what "by payor" should mean

It sums **remit only**, never cost or margin. That is a receivable, it is a fact about each payor's
own transmission, and it is exactly right. Nothing to change; it is the model for the fix.

---

## "Expected from payor X", defined so an 835 reconciles line by line

Two statements, both true, never added together:

- **The fill owns the profit.** One cost, one revenue across every payor and the patient.
  `Fill.marginCents` is that figure and it is already correct.
- **Each payor owns its receivable.** Its own remit on its own transmission, settled only by its own
  835. **That, and nothing else, is "expected from payor X."** It is a fact, not an allocation, which
  is why a remittance can match it or fail to.

Implemented as `payerShares()` in `fills.ts` (this pull request, marked as the fix):

| Figure | What it is |
| --- | --- |
| `receivableCents` | that payor's own remit. The 835 settles this and only this |
| `costShareCents` | the bottle's cost × (this payor's remit ÷ all payors' remit) — **a stated convention, not a fact** |
| `marginCents` | receivable less cost share |

Pro rata on remit is chosen for one reason: it is the only split that adds up. `sharesReconcile()`
proves it on every fill — the payors' margins plus what the patient paid equal the fill's margin,
to the cent.

**The patient's money is given to no payor**, deliberately. It is the residual after the last plan;
the patient pays it *because* the plans did not, so crediting it to a plan would reward a payor for
covering less.

**Where the payors together paid nothing, there is no share** — nought over nought is not a
proportion, and inventing one puts the whole bottle on whichever payor happened to be first, which
is the error this exists to end.

On the pharmacy's own coordinated shape ($462.50 primary, $458.29 RxRescue, $1,306.23 bottle), the
answer is that **both payors are underwater and the fill loses money** — not that one lost $843.73
while the other earned $458.29 of pure profit.

## What I have not changed, and why

**`payer-map.ts` still keys on `payers[0]`.** Rewiring it changes a ranking the owner reads, and the
right shape depends on a question only he can answer: should a top-off card appear in "Paying
best/worst" beside a plan at all, or in its own table as the performance page already argues for
subsidy cards? The function to do it with is here and tested. **Recommended:** score each payor on
its own `payerShares` row, keep subsidy cards in their existing separate ranking, and add "expected
from" as the receivable column so the 835 side has something to reconcile against.

Findings, plus `payerShares`/`sharesReconcile` as the marked fix. The wiring is session 1's call.
