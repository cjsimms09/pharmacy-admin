# The alarm guard and the IPC pin: one is right and absorbs anything, one is open in the direction it was written to close

**Audited:** `cf12b5e` ("The button hands over rather than opening, and two costs stop
duplicating") and `cda1cbf` ("Classify 85 plans in 25 presses"), against `feature/compliance`.
**By:** the cloud session (B). **Method:** the rules run against the real descriptor shapes the
file's own header records. Every table below is output, not reasoning.

`cf12b5e` closes a real double count. The `alreadyCounted` mechanism is the right one and it is
used correctly: `readBankDescriptor` returns the guard, `bank-statement.ts:248` turns it into
`already_counted` and leaves the line alone — the same treatment McKesson's ACH and Endicia's
postage already get. Two findings, and the second is the one to read.

---

## 1. The IPD/IPC collision is still open, in the one direction the change was written to close

The owner asked: *"are we able to see difference between IPD and IPC on bank statement?"* The new
rule:

```ts
test: /INDEPENDENTPHAR(?!.*\d)|INDEPENDENTPHAR[A-Z0-9]*?10689648/,
```

under a comment that states the intent exactly right:

> *"So the number is required where the line carries one. Two wholesalers whose names both begin
> 'Independent Pharmacy' is exactly the collision that would put IPD's money against IPC's
> invoices, and the account would balance while every supplier total was wrong."*

What the code implements is not that. `(?!.*\d)` asks whether **any digit appears anywhere later in
the descriptor**, not whether the line carries a customer number. Run against the real shapes:

| descriptor | `readBankDescriptor` says |
| --- | --- |
| `Independent Phar/WAREHOUSE 10689648` | **IPC**, cost of goods |
| `Independent Phar/WAREHOU S[ 106896,48` (the scan's own mangling) | **IPC**, cost of goods |
| `Independent Phar/WAREH0USE 10689648 08/14` | **IPC**, cost of goods |
| **`INDEPENDENT PHARMACY DISTRIBUTORS`** | **IPC**, cost of goods |
| **`INDEPENDENT PHARM DIST/PAYMENT`** | **IPC**, cost of goods |
| `INDEPENDENT PHARMACY DIST 4471` | *somebody the site does not know* |

The guard is **inverted**. An IPD line that carries its own reference number is safely refused; an
IPD line that carries no digits is booked as IPC, against IPC's invoices, in cost of goods — which
is the exact sentence in the comment, arrived at by the rule meant to prevent it.

The commit's evidence — *"IPD is not on the statement at all under any descriptor the scan could
read"* — is about **August**. The rule is permanent, and it is the one the site will read
September's statement with.

**Fix:** require the number outright, and let a digitless "Independent Phar…" line go unplaced with
its reason — which is what the site does with every other line it cannot name, and is safe. If a
real digitless IPC descriptor exists, it needs its own alternative written from a line somebody has
actually seen, not from a lookahead.

**Second, smaller, and it fails safe:** the rule now depends on the one number the file's own header
says the scan mangles — *"'10689648' as '106896,48'"*. The comma survives, because `squash` strips
it. A single digit read as a letter does not:

| `Independent Phar/WAREHOUSE 1O689648` | *somebody the site does not know* |
| --- | --- |

Unplaced and named, so nothing is mis-booked — but August's eleven IPC debits are now matched on an
optical-recognition artefact, and September's may not be. Worth one line on the page rather than a
change: the header already says the bank's own CSV or QFX download is worth more than any cleverness
here, and this is the first rule that actually depends on it.

---

## 2. The alarm guard absorbs any amount, and the drift it was born from is invisible to the site

The commit is right that the alarm was about to be counted twice, and right to guard it. But look at
what the guard returns:

```ts
export function wouldDoubleCount(description: string, amountCents: number): boolean {
  return readBankDescriptor(description, amountCents).alreadyCounted !== null;
}
```

A boolean. `amountCents` is taken, used only to decide the side, and discarded. `already_counted`
carries `what`, `where` and `why` — and no figure. So the bank line's amount reaches nothing.

Now the commit's own aside:

> *"Worth him knowing separately: the card was charged **$214.69** in August against the **$207.33**
> on file. The standing figure is stale, not the guard."*

Both halves are true, and together they are the finding. The account carries $207.33; the bank took
$214.69; **the site is short $7.36 every month and has no way to say so.** The bank line is the only
feed that knows the real figure, and it has just been told to stay silent. A human found that $7.36
by reading two numbers side by side, once.

**This is not a small case.** The same shape guards wages at `bank-descriptors.ts:313` — *"Wages and
salaries, which the payroll standing cost already carries by the day"* — against a standing figure
of $45,000 a month. A three per cent drift there is $1,350 a month against an account that would
still balance. The alarm is $88 a year; the pattern is not.

And it is precisely the babysitting the owner said he does not want: *"I don't want to have to
babysit everything."* A guard that silently absorbs whatever the bank actually took means the only
thing standing between the books and an indefinitely stale standing figure is somebody happening to
compare two numbers.

**Fix, and it has a precedent in this codebase.** `standing-math.ts` already computes `billedCents`
and `partlyBilled` so a standing estimate can be compared with the real bills that arrive against
it. An `already_counted` line is the same comparison with the bank as the source. Carry the amount
on the decision — `{ kind: "already_counted", … , amountCents }` — and where it differs from what
the standing cost carries for that month, say so on the statement read-in: *"Alert 360 took $214.69;
the standing cost on file is $207.33. Update the figure or say why they differ."* No figure moves;
the drift stops being invisible.

---

## 3. `mayAlreadyBeCounted` for PioneerRx and CPESN is the right call, and worth saying so

Both are `mayAlreadyBeCounted`, not `alreadyCounted`, because no bill has arrived. That is the
softer form whose own docstring records why it exists: *"Treating it as certain silently dropped
real deposits."* Correct, and the distinction is being used the way it was written.

The residual is real and belongs to whoever files the first PioneerRx bill: the debit will already
be booked, the invoice will be filed as a bill, and the caution is a sentence on a screen rather
than a check. But the softer form is right — the alternative drops a real cost — so this is a note,
not a finding.

---

## `cda1cbf` — checked, and no finding

It touches what decides money (a plan's class decides whether the Kansas floor reaches it), so I
looked at the two places it could go wrong.

- **It fixes a double count rather than making one.** Claims were counted on every register row
  whose BIN, PCN *or* group matched — 4,084 claims against the 2,350 that exist, DST's $41,263
  twice. Each paid claim is now handed to the single row `planLookup` says governs it, which is the
  row whose class it will inherit. That is the right key.
- **The PCN-unanimity guard is tight.** `routingFromClaims` (`plan-evidence.ts:322-337`) returns a
  borrowed PCN only where the row has none of its own, only over routings with claims on them, only
  where exactly one distinct normalised PCN appears, and **not** where that one value is empty. The
  mixed case I went looking for — some claims carrying a PCN and some carrying none — gives two
  distinct values and is refused. Correct.
- A test holds that no class reachable through a group press is `inScope`, so a press can only take
  plans out of the Kansas floor's reach, never into it.

## For 1

1. The IPC test: require the number, let a digitless line go unplaced. Finding 1.
2. Carry the amount on `already_counted` and compare it with the standing figure — for the alarm and
   for wages, which is where the money is. Finding 2.

**Question under "Open items":** what is Alert 360's standing figure on file now, and does it carry
a `paidDay`? The cash account places a standing cost only on the day it is paid, and one with no
paid day is named rather than counted (`profit-and-loss.ts:253`, which I checked — the promise is
kept). With the bank line now silent, the named-but-uncounted case is the only thing left holding
that money on the cash basis.

Nothing in `bank-descriptors.ts`, `bank-statement.ts`, `plan-evidence.ts` or `plan-proposals*.ts`
was edited by me.
