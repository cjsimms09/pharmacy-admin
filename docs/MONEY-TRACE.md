# Every dollar, from the prescription to the bank

The owner, 11 September 2026: *"we should be able to track this all the way through from claim to
835 to cash in account"*, and *"the logic is complex and needs to be perfect"*.

This is the map. It exists because the same dollar appears in four or five documents on its way in,
and counting it in two of them is the failure that has already happened here more than once —
$627,408.46 of phantom August cash profit, revenue counted with no costs against it, a facilitator
deposit silently dropped.

## The rule that makes it safe

**Count a dollar at exactly one point in its chain: where it reaches the operating account.
Everything upstream is explanation, not money.**

An 835 is a *decision*. A ProviderPay payment is a *promise kept*. A sweep deposit is money in
somebody else's holding pen. Only the transfer into the pharmacy's own account is cash, and that is
the line the bank statement shows — which is the authority the owner named: *"By end of month our
cash accounting should match our bank account."*

Accrual is the opposite question and has its own single point: the day the patient took the
medicine. Everything after that is a revision of an estimate, never a second sale.

## The routes money takes in

### 1. A plan, through ProviderPay

The long chain, and the only one with a holding account in the middle.

```
fill  →  835  →  ProviderPay payment  →  Wells Fargo sweep  →  ProviderPay Transfer  →  the bank
```

Every join is an identifier, not a guess:

| Join | Key |
|---|---|
| fill → 835 | prescription number and fill number |
| 835 → payment | the remittance's trace number; the portal prints the pairing both ways (*Payment match* on Remittances, *Remit match* on Payments) |
| payment → sweep deposit | the payment number, which appears in the deposit's description |
| deposit → transfer | same day; the transfer nets that day's deposits exactly |
| transfer → bank | date and amount — **the only inexact join in the whole map** |

That last hop is inexact because a transfer carries no reference of its own. It is one lump a day,
so the risk is small, but it is the place to look first when a month will not tie.

- **Cash**: on the transfer date, in the operating account. Never on the deposit into the sweep —
  a payment landing 31 August and sweeping 1 September is September cash to the bank, and dating it
  in August guarantees the month never agrees.
- **Accrual**: at pickup, at what PioneerRx expected. Revised when the 835 arrives (below).

### 2. A plan paying direct

Payers outside ProviderPay deposit straight into the operating account. Same rules, one link fewer.

### 3. The Medicare Transaction Facilitator

`fill → MTF remittance → deposit`. Cash on the deposit; accrual when earned. Its money was never in
the adjudicated amount, so it is additional revenue rather than a settlement of the claim.

### 4. Aytu / IPD RxRescue top-offs — the one that never reaches the bank

```
fill  →  credit memo  →  a credit line on the IPD statement  →  a smaller payment to IPD
```

No deposit ever arrives. The benefit is a cash *outflow that does not happen*.

- **Accrual**: revenue, when the memo is earned. The claim's own remittance is separate money.
- **Cash**: **not revenue, at all.** It shows up as a smaller payment to IPD, and cash cost of goods
  is built from what was actually paid — so the benefit is already in the books once.

Worked, because this is where double-counting is easiest:

> A drug costs $1,000. The plan pays $800. Aytu tops off $200 as an IPD credit. The pharmacy then
> pays IPD $800 instead of $1,000.
>
> **Right** — accrual: revenue $1,000, cost $1,000, nothing made or lost.
> **Right** — cash: $800 in from the plan, $800 out to IPD, nothing made or lost.
> **Wrong** — count the $200 as cash revenue *and* take cost as the $800 actually paid: $200 of
> profit that does not exist.

Two things must therefore hold, and both are worth checking against the first real statement that
carries a credit:

1. No RxRescue payment ever creates a cash receipt. *(True today: `rxrescue-credit.ts` books none,
   and the automatic facilitator banking in `profit-and-loss.ts` filters `source === "mtf"` only.)*
2. The IPD payment is recorded at the **reduced** amount. If a credit is applied but the site sees
   the full invoice, cost is overstated by exactly the credit — the same $200, lost the other way.

The tie-out: the credit memo's total should equal a credit line on the IPD statement. Until that is
matched, the top-off is earned but unsettled, and it is neither cash nor a receivable from a plan.

### 5. The patient, at the counter

Copays and cash sales. Accrual at pickup; cash when the till is banked. A patient's share named in
an 835 is **not** a second receipt — it is the same money, described by the plan.

### 6. Rebates

A reduction of the cost of goods, never revenue. Counting a rebate as income overstates both revenue
and margin, and it is not a sale.

## When an 835 changes what was earned

Revenue is accrued at pickup on PioneerRx's expected figure, because that is the best estimate
available on the day. When the remittance later says something different, that is a **change in
estimate** — booked in the month it is learned, not by reopening the month of sale. Restating a
prior period is for errors. (ASC 250; worth your accountant confirming for your own circumstances.)

| What the 835 reveals | Accrual | Cash |
|---|---|---|
| Paid what was expected | nothing to do | on the transfer |
| Short, and the plan says why (`PI`, a larger patient share) | reduce revenue, month the remittance arrived | on the transfer |
| Short, and nothing explains it | **no adjustment** — still a receivable | on the transfer |
| Contractual write-off (`CO`) | nothing — already inside the expected figure | — |
| Patient share (`PR`) | nothing — collected at the counter | at the till |
| Held back at remittance level (DIR, GER, fees) | reduce revenue, month the remittance arrived | reduces the transfer, so it is already in cash |

An unexplained shortfall deliberately adjusts nothing. Nobody has said that money is not owed —
which is exactly what makes it unexplained — and writing it off would turn *"we do not know why"*
into *"we have decided not to be paid"*, silently, on a figure nobody has looked at.

## What must never be counted twice

Each of these has been got wrong at least once:

- A supplier covered by a statement is counted **only** from the statement, never also from its
  invoices.
- A ProviderPay payment and the 835s behind it are the same money. The payment is the money.
- A sweep deposit and the transfer that moves it are the same money. The transfer is the money.
- A rebate reduces cost; it is not income.
- An Aytu top-off reduces what is paid to IPD; it is not cash income.
- A patient's share in an 835 is the copay already taken at the till.
- On a fill billed to two plans, the primary's patient share and the secondary's payment are the
  same dollars. See `claim-reconcile.ts`.

## Where this is implemented

| Piece | File |
|---|---|
| Is a claim settled, and why is it short | `src/lib/claim-reconcile.ts` |
| Reading an 835 | `src/lib/x12-835.ts` |
| Recording a payment, and the books boundary | `src/lib/claim-payments.ts`, `src/lib/books-start.ts` |
| Cash cost of goods, and the counted-once proof | `src/lib/cash-cogs.ts` |
| Bank statement lines and what they mean | `src/lib/bank-descriptors.ts`, `src/lib/bank-statement.ts` |
| The register of things that must be counted once | `src/lib/books-check.ts` |
| Getting the month out of ProviderPay | `docs/PROVIDERPAY.md` |

## Two different problems that look identical on a claim

A generic dispensed below cost is either an underpayment or a bad buy, and the claim alone does not
say which. Splitting September's first eleven days three ways:

| | Claims | Amount | What it is |
|---|---|---|---|
| Paid **below** NADAC | 101 | $1,077.74 | A MAC underpayment. Worth appealing. |
| Paid **at or above** NADAC, cost above NADAC | 87 | $1,777.17 | A buying gap. Not appealable. |
| Bought above NADAC, all causes | — | **$2,582.56** | Eleven days. Order of $85,000 a year. |

The second column is the one that matters, and it is the one a MAC appeal cannot fix. Asking a PBM
to pay above the national average because this pharmacy's buying is expensive gets declined, and
rightly.

Worst of it, September 1–11:

| Drug | Cost | NADAC | Over |
|---|---|---|---|
| Dextroamphetamine-amphetamine ER 10mg | $124.07 | $31.63 | +292% |
| Buprenorphine/naloxone 2mg | $178.57 | $77.20 | +131% |
| Lisdexamfetamine 60mg chewable | $239.24 | $105.30 | +127% |
| Enoxaparin 40mg syringe | $202.89 | $97.50 | +108% |
| Lisdexamfetamine 40mg and 50mg | ~$165 | ~$80 | +106%, across five fills |
| Ivermectin 3mg | $482.31 | $247.59 | +95% |

Two caveats that stop this being a simple win: some of it is unavoidable, because lisdexamfetamine
has had real supply problems and controlled substances have fewer suppliers, and NADAC is a national
average nobody beats every time. But lisdexamfetamine appearing five times at 106% over NADAC is a
purchasing decision somebody can check, not bad luck.

`product-ledger.ts` already flags `buying_above_nadac` and `cheaper_elsewhere`, and
`/purchasing/products` shows them as badges. What is missing is the ranking: nothing puts these in
order of the money actually lost on claims actually dispensed, which is why $2,582.56 in eleven days
was invisible until somebody went looking for it while filing appeals.
