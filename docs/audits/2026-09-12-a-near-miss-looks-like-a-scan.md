# A 91%-read invoice and an unreadable scan look identical on the page

**Audited:** `6a04682` against `feature/compliance`. **By:** the cloud session (B).

Four fixes, all sound, and the schedule chain in particular is right in every step — verified below
rather than assumed, because it decides a DEA recordkeeping question. One finding, and it is the
general case of the bug this commit just fixed.

---

## The finding: the discard is defensible, and it leaves no trace

The commit's own account of what went wrong:

> *"Three of six lines matched on invoice 7491384103 and none on 7491383165. Because what matched
> came to $657.98 against a printed $722.34, the reading did not reconcile and **every line was
> discarded** — which on the screen is an invoice with a total and no items, **indistinguishable from
> an unreadable scan**. Neither was a scan."*

The pattern is fixed. The **policy** that turned a partial read into a total loss is unchanged:

```ts
if (reconciles === false) return { stored: 0, unread: good.length + unread, reconciles: false, readCents: sum };   // invoices.ts:1412
if (parsed.reconciles === false) return { stored: 0, …, readCents: parsed.totalCents };                            // invoices.ts:2571
```

**Refusing to store a partial read is the right call** — lines that sum to less than the invoice make
purchases-by-item wrong in a way that looks right, which is this repository's own principle that a
total is a floor unless every part of it was measured. Nothing below argues for storing them.

What is wrong is that **the near-miss is computed at the moment of the discard and thrown away with
the lines**. Both return sites already carry `readCents` (the $657.98) and `unread` (how many lines
were seen), and the printed total is in hand. Nothing writes any of it onto the invoice. The backfill
counts them only in aggregate:

```ts
// Read, but the lines did not add up to the printed total, so none were kept. Named
// separately: it is a layout this reader does not fully know, not a scan.
if (r.reconciles === false) unreconciled++;     // invoices.ts:1507
```

That comment states exactly the distinction the invoice row cannot make. One number for the whole
run tells the owner that *some* invoice somewhere was 91% read; it does not tell him **which**, or by
how much it missed, and the invoice itself still reads as a total with no items.

**So the next supplier whose layout shifts by one column produces the same silent total loss**, and
it will again be found only because somebody happened to look at an invoice — which is how this one
was found. The commit cured ParMed; it did not cure the class.

**Fix, and the data is already in the function:** record the near-miss on the invoice at the discard
— lines read, cents read, printed total — so "read but did not reconcile" is visibly a different
thing from "nothing could be read", and the gap names itself: *"6 lines read coming to $657.98
against a printed $722.34; none stored because they do not add up."* That sentence is the difference
between a reader fault somebody can fix and a scan nobody can.

---

## Checked and sound — the schedule chain, verified at every step

This decides whether an invoice is filed as a Schedule II record, so I checked the premise rather
than taking it:

- **"The directory's blank means not a controlled substance" is true of this data.**
  `drug-directory.ts:157` populates the column straight from the FDA product file —
  `deaSchedule: r.DEASCHEDULE || null` — and `DEASCHEDULE` is column 18 of that file. A blank in a
  row the FDA lists is the FDA's own "not scheduled", not missing data. The commit's premise holds.
- **`scheduleFromInvoiceLines` refuses on anything less than complete knowledge**: every line must
  carry an NDC (`ndcs.length !== lines.length` → null) and every NDC must be in the directory
  (`scheduleOf.has(n)` → null). *"An invoice is shown to be free of controls only when every line has
  been looked at"* is what the code does.
- **`scheduleFromDea` is strictest-wins and cannot be talked into "none"**: any CII → `schedule_2`,
  any CIII–CV → `schedule_3_5`, and `"none"` only where **every** code is explicitly `0` or `00`. An
  unrecognised code returns `unknown`, never `none` — so a Schedule I code, a typo, or a vocabulary
  this does not know all send the invoice to the drawer.
- **Spelling the blanks as `"0"` rather than dropping them is right**, and the reason given is the
  real one: an empty list reads as `unknown`, so dropping them *"would turn an invoice of nothing but
  insulin into an empty list and put it straight back in the Schedule II drawer."*

Every step errs toward the drawer, which is the direction 21 CFR 1304.04(h)(1) requires. Nothing to
do here.

**Also unchanged, so not re-reported:** `money()` and `MONEY` in `invoice-lines.ts:85-86` still carry
no sign or bracket handling, so a credit line printed `-11.87` or `(11.87)` is not matched as a row
at all. That is the open finding from 8 September and this commit does not touch it.

## For 1

1. The near-miss on the invoice at the discard. The data is already in the return value.

Nothing in `invoices.ts`, `invoice-lines.ts`, `drug-directory.ts` or `inbox-resort.ts` was edited by
me.
