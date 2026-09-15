# Rebates are not double counted. A dateless invoice is money the rebate figures cannot see.

*12 September 2026 — session 2 (cloud). The rebate path read end to end: `rebate-report.ts`,
`rebate-rates.ts`, `money-position.ts`, `over-nadac.ts`, `drug-profit.ts`, `expenses.ts`. Prompted by
the owner's standing instruction — *"make sure logic is perfect, we are accounting for all money, and
not duplicating"* — and by "rebates and remits" being named in it. **No file of session 1's is
edited.***

## Cleared: the rebate is counted once

The obvious way for a rebate to be counted twice is to reduce the cost of the goods **and** arrive as
income. Both halves are really there, so it was traced rather than assumed.

**Income, once.** A wholesaler's rebate settles as a `cashReceipts` row keyed on a source key, and
`addCashReceipt` refuses a second receipt for the same key — with one deliberate exception for a
corrected statement, which `updateCashReceipt` handles by changing the amount rather than adding a
row (`expenses.ts:327-347`). One rebate, one receipt.

**Cost, only in decisions.** The rebate-reduced unit cost appears in `over-nadac.ts` (`effectiveMicros`),
`minimum-store.ts:86`, `month-plan.ts:165` and `drug-profit.ts:424`. Every one of those is a buying
question — which supplier, which pack, how to reach a minimum — and in `drug-profit` the figure is
used on **both sides of a subtraction** (`gainPerFillCents = best.margin − current.margin`), so the
rebate cancels out of the answer entirely. None of them writes to the books.

**The estimate is not added to anything.** `money-position.ts` carries `rebates.estimatedCents` —
what this month's buying is earning — and it is rendered as one standalone tile on Today
(`page.tsx:516`, "Rebates earned this month"), summed into no cash or profit total. It is an accrual
estimate for the *current* month; the cheque it anticipates settles a *past* one. They do not meet.

So the rebate is booked once, as income. Nothing here double counts it.

## The finding: a line with no invoice date is invisible, and nothing says so

`earningSoFar` selects the month's lines by date:

```ts
where: and(gte(schema.invoiceLines.invoiceDate, `${m}-01`),
           lte(schema.invoiceLines.invoiceDate, `${m}-31`))    // rebate-rates.ts:316-318
```

`invoice_lines.invoice_date` is **nullable**, and so is `supplier_invoices.invoice_date`. A null is
neither `>= "2026-09-01"` nor `<= "2026-09-31"`, so a dateless invoice's lines are in no month at
all — not this one, not any. The same filter, silently, in the purchasing comparison:

```ts
const inWindow = input.lines.filter((l) => l.invoiceDate !== null && … );   // over-nadac.ts:100
```

`excluded` is pushed to further down for a missing pack size and for a missing NADAC, each with a
sentence. For a missing date there is no entry at all.

**What makes this worth a line is the contrast in the same code.** `earningSoFar` goes to real
trouble over the *other* way a line can fall out. A line whose supplier cannot be placed is counted,
its money summed, its printed names collected, and its docstring says so explicitly —

> *"A name that matches none of them places the line nowhere, and **it is counted and named below
> rather than dropped**."*

— and `suppliers/page.tsx:283-299` renders it with the money, the names and the remedy: *"Nothing
below counts them — not the purchases, not the ratio, not the rebate."* That is exactly right, and
it is exactly what a dateless line does not get.

**And the codebase already knows the shape**, for the other consequence:

> *"A dateless invoice is in the archive and outside every date range, which is the one form of
> retrieval an inspector actually uses."* — `setInvoiceDate`, `invoices.ts:2127-2131`

It names the compliance cost of a missing date and gives a person the remedy. The money cost — the
purchases not counted, the ratio not moved, the rebate not earned, the over-NADAC row not compared —
is the same fact and is said nowhere.

The fix is small and the pattern is already written: count and name dateless lines the way unplaced
ones are counted and named, and let the rebate card and the over-NADAC card say so. The remedy
already exists and is reachable — `setInvoiceDate` is on the invoices page.

## Not wrong today, and one thing that would say

Nothing here says a figure is wrong. Whether it bites depends on a count only the pharmacy computer
can take, and it is one query:

```sql
select count(*), sum(extended_cents) from invoice_lines where invoice_date is null;
select count(*) from supplier_invoices where invoice_date is null;
```

Anything but zero is purchases sitting outside every rebate figure and every purchasing comparison,
with no screen saying so. If it is zero today, the guard is still worth having: an invoice arriving
without a readable date is ordinary enough that `setInvoiceDate` was written for it.
