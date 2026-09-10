# The sold-month rule is right; the window the fills are loaded through is not

**10 September, Helper B (cloud).** Reviewing `a19d100` — *"A prescription is revenue when the
patient takes it away, not when it is filled"* — merged into `feature/compliance` last night.

The rule is correct and the reasoning behind it is correct: a fill in the will-call bin has earned
nothing, its stock is inventory rather than cost of goods, and an unclaimed script is reversed after
a fortnight. Nothing below argues with any of that. What follows is about the join between the new
rule and the query that was already there, which was not changed with it.

---

## 1. A fill carried in from the previous month is revenue in no month at all

`monthInputs` now slices the month by the day the script was collected:

```ts
const monthFills = fills.filter((f) => (f.soldOn ?? "").startsWith(month));   // profit-and-loss.ts:786
```

`fills` reaches it from `loadShared`, which loads them like this:

```ts
const from = `${sorted[0]}-01`;
const to = `${sorted[sorted.length - 1]}-31`;
allFills({ from, to })                                                        // profit-and-loss.ts:719
```

and `allFills` filters **on the fill date**, not the completed date:

```ts
where: and(gte(schema.claims.dateFilled, from), lte(schema.claims.dateFilled, to))   // claims.ts:1316
```

So the account is *sliced* on `soldOn` out of a set that was *selected* on `dateFilled`. A script
dispensed on 30 June and collected on 2 July is July's revenue under the new rule, and it is never
loaded when July is the only month asked for. It is not deferred to another month; it is in none.

### Measured

Seeded into an empty migrated database — two claims, no other rows, everything else equal:

| | rx | filled | collected | remit |
|---|---|---|---|---|
| A | 1000 | 2026-06-30 | 2026-07-02 | $100.00 |
| B | 2000 | 2026-07-05 | 2026-07-06 | $200.00 |

Then the same month, asked for two ways:

```
July asked for on its own:         revenue   20000c   fills 1   cost   12000c
July inside a June-July window:    revenue   30000c   fills 2   cost   18000c
June inside that same window:      revenue       0c   fills 0   cost       0c
```

June reading zero is the new rule working exactly as intended — its one script was collected in
July. July reading two different numbers depending on what else was asked for alongside it is the
fault. The difference is fill A, entire: $100.00 of revenue and $60.00 of cost.

### Both callers are real, and they disagree with each other

- `booksFor(period)` on a **month** period passes one month (`ledger-store.ts:64`), so the Money
  page's books for September are drawn through a window of September fill dates. Every script
  dispensed in August and collected in September is missing from them.
- `recentMonths(n)` passes n months at once (`ledger-store.ts:137`), so the chart's September is
  drawn through a window that begins n months earlier and **does** contain those fills.

The books page and the chart therefore answer the same question with different numbers, and the
month page is the one that is short. That is the failure this repository has named more than once:
the claims screen, the payer table and the dashboard cannot be allowed to give different answers to
the same question.

### The shape of a fix, not applied

`profit-and-loss.ts` is money logic and not mine to change; this is for whoever takes it.

Querying on `completedAt` instead is not the fix — `waiting` needs the fills that have no completed
date at all, selected by the month they were filled in:

```ts
const waiting = fills.filter((f) => !f.soldOn && f.dateFilled.startsWith(month));
```

so the window has to keep covering both. The small honest change is to widen its front end by
enough months that anything collectable in the wanted months is inside it — a script unclaimed for
a fortnight is reversed, so one month is already generous — while leaving the slices as they are:

```ts
const from = `${monthBefore(sorted[0])}-01`;
```

Whatever it becomes, it wants a test that asks for one month and then the same month inside a
wider window and asserts the two agree. There is not one today: **nothing in `tests/` calls
`accountsFor`, `loadShared` or `allFills`**, which is why the window and the slice could be put on
different columns and every check still passed.

## 2. The first month of any window is short for the same reason

The same arithmetic applies at the front edge of a multi-month window. A twelve-month strip
beginning 2025-10 loads no fill dated September 2025, so the scripts collected in the first days of
October 2025 are missing from its first column. Every month after the first is whole. It is the
same defect as §1 and the same fix closes it.

## 3. `scriptCounts` was left on the filled basis, and it carries a second revenue figure

`accountsFor` hands the page its fills projected to three fields, and the projection is by fill date:

```ts
fills: shared.fills.map((f) => ({ dateFilled: f.dateFilled, cashPlan: f.cashPlan, revenueCents: f.revenueCents }))
```

`scriptCounts` then filters on `dateFilled` alone (`ledger.ts:295`) and returns `scripts`,
`thirdParty`, `cash`, `perDay`, `byMonth[].revenueCents` and `averageRevenueCents`.

The count may well be deliberate — "how many scripts did we dispense" is a fair question with a
different answer from "how many did we sell", and the pharmacy session should say which the owner
reads. The revenue is not the same case. `averageRevenueCents` is filled-basis revenue over
filled-basis scripts, displayed beside an account whose revenue is sold-basis. By `a19d100`'s own
measurement those two bases differ for September by **$98,890.41 across 494 prescriptions**, so
these are two numbers called revenue, on one page, that no arithmetic relates.

`monthInputs` also sets `claimsCount: monthFills.length`, which *is* on the sold basis. So the
books already hold both definitions of "how many scripts", from one read.

---

## What I cannot measure from here

Everything above is mechanism, demonstrated on rows I made up. The size of it is a question for the
pharmacy computer, and I have put it under "Open items" in `HANDOFF.md`:

- how many September fills have `completed_at` in September and `date_filled` in August — that is
  the money the books page is currently dropping, and the chart is not;
- whether the books and the chart disagree today for August, which would confirm §1 on real rows
  rather than seeded ones;
- what the front-of-page script count is meant to mean, before anything is changed to match it.
