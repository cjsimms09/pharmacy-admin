# The Money books: the fold, and what the books still cannot see

8 September 2026 · Helper A · branch `work/money-fold`

The owner: *"The money tab needs to have sound logic, needs to not forget about expenses or revenue
it knows, needs to not double count things. This is how I will track financials of pharmacy. It
should be able to operate on a cash and accrual basis. It needs to take into account everything and
needs to do it correctly."*

Three requirements. This turns each one into something that can fail, folds the two period modules
into one, and names what is still missing.

---

## 1. The fold

Two period modules landed the same night and both were wired into the sidebar.

| | The books | The reports |
|---|---|---|
| Page | `/money` | `/money/report`, `/money/report/print` |
| Period | `ledger.ts` — `Period`, `parsePeriod`, `periodOf`, `neighbours` | `period-account.ts` — `Period`, `parsePeriod`, `quarterOf`, `periodsFor`, `previousPeriod` |
| Sum | `combineMonths` → `PeriodPL` | `periodTotals` → `PeriodTotals` |
| Read | `ledger-store.booksFor` → `loadShared` once per basis | `periodAccount` / `monthlyTrend` → `loadShared` **once per month** |

Two definitions of "Q3 2026" and two routes to the same figures. What changed:

**One period.** `period-account.ts` no longer defines `Period` or `parsePeriod`; it re-exports
`ledger.ts`'s, which was the richer of the two — its periods carry `from` and `to`, which the books
filter claims by and the reports never had. The long quarter label (`Q3 2026 — July to September`)
came the other way. `tests/period-account.test.ts` now asserts the two modules export the *same
function object*, so this fails the moment anybody writes a second one.

**One read.** `accountsFor(months, basis)` in `profit-and-loss.ts` is now the only place a month's
account is produced from the database. `monthlyAccount`, `periodAccount`, `monthlyTrend`,
`booksFor` and `recentMonths` all go through it.

The speed was the smaller half of this. Drawing `/money/report` for a quarter with a twelve-month
chart used to be **18 full passes over every claim the site holds** — 3 for the period, 3 for the
period before it, 12 for the chart, each one its own `loadShared`. It is now **3**, one per distinct
run of months, and the held cache collapses repeats within a request. On a year the reports were 12
passes; they are 1.

The bigger half is that two routes to a number are two numbers eventually, and this is his books.

**One rule about empty months.** The reports left a month with nothing on file out of the
arithmetic and named it; the books ran it through the account and produced a column of noughts with
a page of "this is missing" beside it — eleven of them on a year, burying the months that really
were short of a line. The books now follow the reports' rule, and `PeriodPL.emptyMonths` names them
on the page: *"2 of the 3 months in Q3 2026 have nothing on file."*

### A hole the fold opened, and closed

`accountMonths()` is the gate that decides which months exist. It was drawn from sales months,
expense invoice dates and claim fill dates — **all three accrual feeds**. Making the books use that
gate meant a month whose only record was a deposit had nothing to report on and vanished from both
surfaces, taking the cash account's only revenue with it. Cash receipts are now in the gate.

Worth stating because it is the shape of the whole problem: the cash side has exactly one feed
today, and every list in the site was built by somebody thinking about the accrual side.

---

## 2. Nothing counted twice — `countedTwice()`, and the register on the page

Six figures in this pharmacy are on file in two places. Both records are true in each case, and
adding both is the natural thing for a program to do. `monthlyPL` already decides each pair; the
decision was buried in a branch. It is now a register — what the money is, the two records, which
one wins, and **the amount the rule kept out of this period** — on `/money` under "Counted once".

| The money | Route A | Route B | Which wins |
|---|---|---|---|
| What the prescriptions took | System Sales Summary, prescription lines | The claims: remit + patient paid | The summary. The claims stand in only when no summary is loaded, never added. |
| What was bought from the wholesalers | Supplier invoices | A bill on Spending under "Drug purchases" | The invoices, always. The bill is dropped and named. |
| The wholesaler rebate (accrual) | The ladder's estimate | The wholesaler's statement on Spending | The statement. The estimate goes to nought. |
| The wholesaler rebate (cash) | A receipt of kind "rebate" | A bill on Spending saying the same | The receipt. The bill is dropped. |
| Payroll and rent | The standing cost, accrued by the day | The real bill for the month | The bill. The standing cost is dropped before the account is built. |
| Facilitator money reaching the bank | A typed receipt | The payer payment report the site reads | The typed receipt; the report stands in where none was typed. |

`tests/books-check.test.ts` builds the fixture the brief asked for: a month where the prescriptions
are on file twice *and* the rebate is on file twice. $510 of prescriptions and a $40/$45 rebate. A
books page that adds either pair prints $1,020 of revenue and a 100% margin.

**No double count found.** Every pair is decided correctly today. The value here is that the
decision is now visible and tested rather than correct by accident.

---

## 3. Nothing forgotten — `feedsInTheBooks()`

The second requirement cannot be met by looking at the account, because what is being looked for is
not on it. So: every feed the site holds that carries money, what it carries, which basis it
reaches, and — the point — what is not in the books because of it.

Thirteen feeds. **Four have a gap that costs money, and three of those reach neither account.**

### The four gaps

1. **Bank lines reach neither account.** The bank statement is read, shown, and used to place a
   deposit against a receipt — and no figure on either basis comes from it. The owner's own rule is
   that the bank is the truth on the cash side. Until the books draw from it, cash revenue is what
   somebody typed rather than what landed, and *a deposit nothing explains, or an 835 with no
   deposit, is not raised as a finding.*

2. **Cash revenue is entirely typed, and it need not be.** The patient's money is cash on the day it
   was collected, and the site already knows that day: `claims.completed_at` is the pickup date. So
   every copay in the period could be placed on the cash account by itself, and none is. A month
   with nothing typed has no cash revenue at all even though every register transaction in it is on
   file. **This is the single largest thing standing between the cash account and being usable**,
   and it needs no new feed — only the fills already loaded.

3. **Plan remittances in the payer payment report do not reach the cash account.** Only the
   facilitator's do. A plan deposit in that feed counts only if somebody *also* types it as a
   receipt — so cash revenue can be short by whatever the payment reports hold and nobody re-entered,
   while the payment report sits in the database saying otherwise. This closes when the 835s arrive
   here; it should not wait for them.

4. **Retail revenue has no cost against it.** Already known and already stated as a caveat on the
   month, but it belongs on this list: the till summary's retail line falls to profit in full,
   because accrual cost of goods is the acquisition cost on each *dispensing* and an OTC sale is not
   a dispensing. It errs in the flattering direction. Nothing in the site stores what front-of-shop
   stock cost.

The other nine feeds reach the books, or are deliberately outside them (on-hand counts are the
*check* on cost of goods and must not feed the thing they check; a supply order carries no price).
The difference between "deliberately outside" and "nobody wired it up" was invisible until it was
written down, and only one of the two is a problem.

---

## 4. Both bases, and the difference explained — `basisDifference()`

Two bottom lines and no account of the gap invites the reader to decide one of them is wrong. The
gap is not a discrepancy. It decomposes exactly:

```
netProfit(accrual) − netProfit(cash)
  = (revenue − revenue) − (offsets − offsets) − (cost of goods − cost of goods) − (operating − operating)
```

Four named parts: revenue earned and not banked (the receivable), money taken back out of revenue,
goods dispensed and not paid for (the payable), bills incurred and not paid. It is an identity, so
when the parts do not add to the difference the page says *"something above this line is wrong and
no explanation of the gap should be trusted until it is found"* rather than printing four numbers
that nearly work. Tested both ways.

### The fixture the brief asked for

One fill: $500 of plan money, $10 from the patient, a bottle that cost $420.

- **July** — the bottle goes out, the patient pays $10 at the register, the plan adjudicates $500.
- **August** — the remittance advice arrives. The plan has *decided* to pay. No money has moved.
- **September** — the deposit lands.

Accrual books $510 in July. Cash books $10 in July and $500 in September. **On July alone the two
views differ by exactly the remit**; across the quarter each basis counts the money once and neither
counts it twice. The month the 835 arrives banks nothing, and the cash account says so rather than
reporting nought as a fact.

---

## 5. The books add up — `booksBalance()`

Every total is the sum of its own lines; every subtotal follows from the one above it; a cash
change is the bottom line less the money out that is not a cost; and an accrual account states no
cash change at all, because nought is a figure and a figure there would be read as "the bank did not
move".

On a **period** this is a real check rather than a tautology: the period's totals are added from the
months while its lines are merged by label — two different pieces of arithmetic over the same rows,
agreeing only if both are right. Which is exactly the check a fold of two reporting modules needs.

It runs every time `/money` is drawn, against the real stored rows, and the page refuses the
statement if it fails. A statement that does not add up is not a statement.

---

## What I could not do from here

I cannot see the database, so three things are stated as findings rather than measured. The queries
are in `docs/HANDOFF.md` under "Open items"; the ones that matter:

- **How much cash revenue is missing today.** Copays collected but never typed, and plan deposits in
  `claim_payments` that no `cash_receipts` row mirrors.
- **Whether the facilitator top-off is inside the System Sales Summary's third-party line.** If it
  is, the accrual account counts it twice — the summary and the `laterMoneyCents` line. I believe it
  is not: the summary is drawn at the point of sale and the top-off lands weeks later. It needs
  confirming against one month, because it is the one double count in this list I could not rule out
  by reading.
- **Whether any month has only banked money.** If so it was invisible on both surfaces before this
  branch, and the figures for that month changed today.
