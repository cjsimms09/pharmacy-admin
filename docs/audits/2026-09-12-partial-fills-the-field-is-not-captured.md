# Partial fills: the site counts two, and the field that would say otherwise is **not-captured**

*12 September 2026 — session 2 (cloud). A fifth item off `FOUNDATIONS.md`'s "still to be checked"
list: *"Partial fills and completion fills. One prescription, two claims, one drug. Does the site
count them as two fills? Does it double the cost?"* **No file of session 1's is edited.***

## The answer to the first half, from the code

```
fillKey(c) = [rxNumber, fillNumber ?? "", dateFilled, ndc11 ?? ""].join("|")      fills.ts:244
scriptCounts(...) -> { scripts: inPeriod.length, ... }                           ledger.ts:327
```

A partial fill and its completion carry the **same prescription number, the same fill number and the
same NDC**, and differ in date of service. `dateFilled` is in the key, so they produce **two fills**,
and `scriptCounts` counts fills, so **two scripts**.

`fills.ts`'s own reasoning is right for the case it was written for and does not reach this one. Its
docstring settles a fill *transmitted twice* — primary then secondary, same date, two BINs — and says
*"Cost is the acquisition price, taken once. Quantity is taken once. Neither is doubled by a claim
being transmitted twice."* That is correct, and a partial plus a completion is a different animal:
two genuine dispensing events of two different quantities on two days.

## The finding, and it is about capture rather than arithmetic

```
OBSERVATION  No dispensing-status field exists anywhere. `claims.mapColumns` (claims.ts:75) maps no
             such column; the `claims` table has none; and a search of src/ and scripts/ for
             "partial fill", "dispensing status", 343-HD or 344-HF returns only unrelated uses — a
             partial *match* in rx-transactions.ts:903, a partial *read* in schema.ts:885, short
             fills in an inventory comment.

SHOULD BE    A partial fill and its completion are one prescription dispensed once and handed over
             in two parts. NCPDP marks them with a dispensing-status code — P on the partial, C on
             the completion — against the same prescription and the **same fill number**, which is
             exactly how they are distinguished from a refill, since a refill increments the fill
             number. For script volume, the number a pharmacy is measured on, that is one script.
             Schedule II partials are the common case and are time-limited by rule, so they are not
             an exotic edge.

DIFFERENCE   Yes, and the difference is not that the arithmetic is wrong — it is that the site
             **cannot tell**. With dispensing status not captured, a partial-and-completion pair is
             indistinguishable from two ordinary dispensings of the same drug on the same
             prescription on two days, and no rule written over the claims table could separate
             them.
```

**Stated in the four states, as `CLAUDE.md` §5 requires**: dispensing status is **not-captured**. Not
"missing" — nobody has yet asked PioneerRx's report for it, so it has never been measured and its
absence says nothing about whether partial fills happen here.

## What I cannot answer, said out loud

**Does it double the cost?** I cannot say, and neither can anyone who cannot see the feed. It turns
on one thing: whether PioneerRx's transaction report puts the **whole prescription's** acquisition
cost on both rows, or each row's own share. If each row carries its own share, two fills is arguably
the right answer and the cost is right; if both carry the whole, the cost is doubled on every partial
fill in the file. The code cannot tell me which, because the column is read as one number either way.

**How often does it happen?** Unknown, and knowable in one query on the pharmacy computer:

```sql
SELECT rx_number, fill_number, ndc11, count(*) rows, count(DISTINCT date_filled) days,
       sum(acquisition_cents) acq, group_concat(date_filled) dates
FROM claims
WHERE source = 'transaction_report' AND status = 'paid'
GROUP BY rx_number, fill_number, ndc11
HAVING count(DISTINCT date_filled) > 1
ORDER BY acq DESC;
```

Every row that comes back is one prescription, one fill number, one drug, dispensed on more than one
day — which is the shape of a partial and its completion, and of nothing else I can think of.
`sum(acquisition_cents)` against what the drug actually cost answers the doubling question directly.

## For session 1

Two things, in order:

1. **Run the query.** Zero rows and this is theoretical. Any rows and the next question is whether
   their acquisition costs sum to one prescription's cost or to two.
2. **Then decide whether to capture dispensing status at all.** It is a column on the report if
   PioneerRx prints it, and one more field in `mapColumns`. But capturing it is only worth doing if
   the query says these exist — and this is precisely the case your own driver clause was written
   about: I have the mechanism, I do not have the fact, and inventing the fact is what I am not
   going to do.
