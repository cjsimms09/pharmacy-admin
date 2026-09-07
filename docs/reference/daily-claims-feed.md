# The daily claims feed this site needs

One row per dispensing, every day, arriving without anybody pressing anything. This is what the
whole reimbursement side of the site is built on: what was billed, what came back, what it cost,
and — the field that matters most — **which term the plan actually paid on**.

Three ways to get it, in order of how much they cost to set up.

## 1. Ask PioneerRx to extend the report that already schedules

The **Rx Transaction Details By Submission Type (BETA)** report already emails itself daily and
already computes estimated rebates and DIR fees, so it is not a fixed template. Adding to it is
the cheapest path by far.

Ask, in this order of value:

| Field | Why it decides something |
|---|---|
| **Primary Basis of Reimbursement** (NCPDP 522-FM) | The plan stating which term it paid on — MAC, NADAC, AWP, U&C. Without it the site has to guess, and the guess is wrong on most fills. Worth more than everything below combined. |
| Dispensed NADAC | The benchmark as of adjudication, not as of whenever it is looked up later. |
| Dispensed AWP | Same, and it is what a discount-off-AWP contract is measured against. |
| Dispensed Item GCN | Groups the NDCs that are the same drug. Nothing else in the feed can do this. |
| Days Supply | A 30-day and a 90-day fill are priced on different lines of a contract. |
| Dispensed Item Name | The current feed has none, so every claim arrives unnamed. |
| Dispensed MAC | The plan's own MAC amount, where it returns one. Lets a MAC-paid claim be checked rather than inferred. |
| Primary Basis of Cost Determination | How the pharmacy's own cost was derived on that row. |

## 2. Make the report that already has these columns schedulable

The **daily_report** canned report carries all of the above and more. It cannot be scheduled,
which is the only reason it is not already the feed. If support can put it on a schedule, or
export it to a folder on a timer, nothing else here is needed.

## 3. Query the database directly

PioneerRx runs on Microsoft SQL Server on the pharmacy's own machine. A scheduled script can pull
exactly these fields nightly with no report involved — and can pull history, not just today.

Double-click **Find the PioneerRx tables.cmd** in the app folder. It needs nothing installed —
Windows already carries what it uses — and it finds the SQL Server and the database by itself.
It reads the table and column *names* only, so the query can be written against what is really
there rather than guessed: no patient data is opened, nothing is written, no lock is taken.

Needs a read-only SQL login. Ask PioneerRx support for one for reporting, and check the support
agreement first — some vendors treat direct database access as outside their scope.

## The columns, whichever route

Required to key a fill: **Rx Number**, **Refill/Fill Number**, **Date Filled**, **NDC**.
Required to price it: **Dispensed Quantity**, **Days Supply**, **Acquisition Cost**.
Required to route it: **BIN**, **PCN**, **Group**, **Network Reimbursement ID** (NCPDP 545-2F).
Required to settle it: **Ingredient Paid**, **Dispensing Fee Paid**, **Copay**, **Remit Amount** —
for the secondary payer as well as the primary, so a coordinated fill is one row.
Required to reason about it: **Basis of Reimbursement**, **NADAC**, **AWP**, **MAC**, **GCN**,
**DAW**, **Status** (so a reversal is not counted as a sale).

## One thing to resolve

In the canned report the two cost figures disagree on half the rows: `Acquisition Cost` against
the cost implied by `Net Profit` — the stated one higher on 57 of 59, and $1,284 apart across a
single day. One is probably replacement cost and the other the actual lot cost. Which is which
decides every margin figure in the site, and it is the evidence a MAC appeal rests on, so it is
worth asking the rep outright.
