# Six figures stamped with tomorrow

14 September 2026 · helper B (cloud) · first run of `CLAUDE.md` rule 6, added this afternoon in
`6e97203`: *"Where another session exists it reads the words before they ship."* This is the second
reader doing that, and it is the one thing in today's twenty-four commits I found that the author
could not have found alone.

---

## The batch, checked first

`a285cb0..6e97203` — 24 commits, 1,516 lines, `npm run check` clean on the merge: **3,318 tests, 730
suites**. I read every new user-facing sentence and traced the money. **No fault in any of it**, and
these are worth recording so they are not re-derived:

- **Receipts cannot double a price.** `product-ledger.ts:292` — `if (byNdcInvoice.has(ndc)) continue;`
  An invoice always wins per NDC; a receipt prices only what no invoice line covers.
- **`receiptLines` is wired**, not another module awaiting a caller: `product-ledger.ts:558-589`
  loads it from `pioneerPurchases` and passes it into `buildLedger`. I checked because a new input
  with no supplier is the shape of half my open findings; this one has one.
- **The zero-cost guard is deliberately duplicated** (`:299`, `if (!(l.unitCostCents > 0)) continue;`)
  and the comment says why — a zero prices a drug at nought and puts it top of every buy list. Right
  call: a guard that depends on a filter in another file staying correct is not a guard.
- **`rebated: null` rather than `false`** on a receipt-priced buy is rule 5 kept where it costs
  something: guessing `false` would invent a cost above what was paid and push drugs onto the
  buying-group list that do not belong there.
- **The cash double-count register already covers this pair.** `cash-cogs.ts:175-211`,
  `countedTwiceInCash`, names all three — the statement and the invoice file, the statement and
  PioneerRx, the invoice file and PioneerRx — and the receiving filter excludes any invoice number
  already present in the invoice file or the statement.

## The finding

```
OBSERVATION: The twenty-four commits were authored 2026-09-14, 11:13 to 11:22 −0500 (git author
             dates). Inside that same push, six sentences date the work **15 September**:

                 src/lib/drug-cost-source.ts:9    "wired receipts into buildLedger on 15 September"
                 src/lib/drug-cost-source.ts:52   "Measured 15 September: ... all 412"
                 src/lib/drug-cost-source.ts:76   "45,906 of them on 15 September"
                 src/lib/data-health-store.ts:519 "on 15 September all 412 of them had one"
                 docs/OPEN-ITEMS.md:143           "looked at on 15 September and all six"
                 docs/OPEN-ITEMS.md:155           "Restored 15 September."

             Two files in the same push date the same afternoon a day earlier:

                 CLAUDE.md:52            "three faults in one day on 14 September" — and the faults
                                         it names are the 608-of-45,906 and the 412, the very
                                         figures stamped 15 September above.
                 product-ledger.ts:68    "it was deleted on 14 September because nothing ever
                                         called it" — the same afternoon's deletion.

SHOULD BE:   A measured-on date names the day the measurement was taken. `OPEN-ITEMS.md`'s own rule,
             at the top of the file: *"Money figures carry the date they were measured, because they
             move."* The stamp exists so a reader can judge whether a figure is still worth acting
             on, which is the only job it has. Two files in one push cannot both be right about one
             afternoon.

DIFFERENCE:  Yes. Six stamps run one day ahead of the measurement, always in the direction that
             makes a figure look fresher than it is — so a figure a week old reads as six days old,
             and a register built to age its own contents ages them wrong. And `CLAUDE.md` rule 6,
             added in this very push to stop the class of fault where a correct number carries a
             wrong sentence, is contradicted by the files it was written about.
```

Ranked **register**, with my row 0. No money, no patient, no board. What it costs is the one thing
the stamps are for.

## What I am not claiming

I do not know **which** is wrong — only that they disagree and that git's author dates say 14
September. If the pharmacy computer's clock is a day ahead, that is a larger thing than six
sentences and it would be stamping every `todayIso()` the same way, including `measuredAt` on stored
proofs and `invoiceDate` on anything filed today. **I cannot see that from here**, and it is the
first thing I would check before editing the six.

I have not touched them. `OPEN-ITEMS.md` is session 1's by standing arrangement, and the other four
are theirs too.

## Pre-flight

1. Physical act — the owner reading a figure off a register and deciding whether it is stale enough
   to re-run. 2. Time — every stamp written today, and tomorrow's if the cause is a clock.
   3. Pharmacist's knowledge — n/a. 4. Whose money — none directly; the exposure is a figure trusted
   a day past its worth. 5. Units — days. 6. n/a. 7. **Worst case ranked** — register integrity only;
   below every money finding on the index and I have placed it accordingly. 8. Could it pass for the
   wrong reason — yes, and this is the point: every one of these sentences has correct arithmetic and
   passing tests, and no test can fail on a date in prose. That is rule 6's whole argument.
   9. When he needs to know — before the next register is generated. 10. Registers — `docs/registers/`
   is generated and not mine; HANDOFF index updated. 11. **What else reads this figure** — the stamps
   are prose, read by people rather than by code; `measureDataHealth` stores its own `measuredAt`
   from the data or from now(), so nothing computed depends on them. Checked.
   12. **What I did not check** — the pharmacy computer's clock, which is the one thing that would
   turn six sentences into a systematic fault. It needs that machine. The question is in
   `HANDOFF.md`.
