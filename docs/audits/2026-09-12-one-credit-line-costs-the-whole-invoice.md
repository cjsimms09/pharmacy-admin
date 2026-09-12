# A return credit on an ordinary invoice costs every item line on it, and is never named

*12 September 2026 — session 2 (cloud). `src/lib/invoice-lines.ts` read against
`src/lib/invoices.ts:1406-1413`. Not tied to one commit: the seam is `MONEY`, which has never
carried a sign. **No file of session 1's is edited.***

## The shape this file already knows

`invoice-lines.ts` records, in its own comments, three separate times one unexpected column cost a
whole invoice:

> *"the rebate flag printing KI and KD … cost $9,890.97 of item lines"*
> *"the fifty-six that parsed then came to $11.59 less than the printed total, and the
> all-or-nothing rule threw away all fifty-six"*
> *"a pattern anchored hard to the end of the line silently dropped the whole line … and
> eighty-three dollars went missing from an invoice that otherwise reconciled"*

Each time the lesson written down was the same: *"on this layout a column that is usually there is
not always there"*. There is a fourth shape, and it is not a missing column — it is a **sign**.

```ts
const money = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
const MONEY = String.raw`[\d,]+\.\d{2}`;                              // invoice-lines.ts:85-86
```

No leading `-`, no brackets. `money()` strips only `$` and `,`.

## What it does, run

Three McKesson lines: two purchases and one return credit — short-dated stock going back, which is
ordinary. $739.11 + $2.32 − $2.32 = $739.11, and the invoice prints that.

```
no credit — three positive lines
  lines read 3   unreadable 0   sum $743.75   printed $743.75   reconciles true

one line is a credit, printed -2.32
  lines read 2   unreadable 0   sum $741.43   printed $739.11   reconciles false

one line is a credit, printed (2.32)
  lines read 2   unreadable 0   sum $741.43   printed $739.11   reconciles false
```

Two things happen and the second is the expensive one.

**The credit line vanishes without trace.** It matches no pattern, and `unreadable` is only pushed
to *inside* a successful match, where the arithmetic or the NDC fails (`:627`, `:663`, `:722`,
`:753`). A line that matches nothing at all is skipped silently — correct for addresses and page
furniture, and it means the one line nobody could read is `unreadable: 0`.

**Then the whole invoice is thrown away.** The remaining lines over-sum by twice the credit, and:

```ts
// Nothing is stored from a reading that does not add up to what the invoice says it came to.
if (reconciles === false) return { stored: 0, unread: good.length + unread, reconciles: false, readCents: sum };
                                                                      // invoices.ts:1412
```

So a $2.32 credit costs all $743.75 of line detail: what each drug cost, which NDC it was, which
item number to reorder by. The invoice's *total* is still an expense on the money side — this is not
lost money, it is lost attribution — but every per-drug question asked of it comes back empty: the
over-NADAC comparison, the cost per unit, the buy list.

And the sentence the screen gives is
*"did not add up to the total printed on them and were left out rather than counted short"*, which
points at the total. The credit line is what is wrong, and nothing says so.

## The fix already exists in this file, for one supplier

IPC's credit note was built in `IPC_CREDIT` (`:179-188`) — `-(\d+)-(\d+)` for the quantities and
`\(\$(${MONEY})\)` for the extended amount in accountant's brackets. It is tried per line rather than
per document, so IPC handles a **mixed** invoice today. Run:

```
IPC, two purchases and one credit on one document
  format ipc   lines read 3   unreadable 0   extendeds 291, 5300, -251   reconciles true
```

Three lines, the credit read as −$2.51, and it adds up. That is exactly the right answer. McKesson,
IPD and ParMed have no equivalent, and the three of them are most of the paper.

The smallest change that would cover all four is at the seam rather than in four patterns: let
`MONEY` carry an optional sign and bracket, and let `money()` read them —

```ts
const MONEY = String.raw`\(?-?[\d,]+\.\d{2}\)?`;
const money = (s: string): number => {
  const neg = s.startsWith("(") || s.includes("-");
  const n = Math.round(Number(s.replace(/[$,()\-]/g, "")) * 100);
  return neg ? -n : n;
};
```

That is a reader of session 1's and therefore a proposal, not a patch. Two things would need checking
on real paper before it went in: that no layout uses brackets for anything but a credit, and that
`lineAddsUp` and `splitQuantities` behave with a negative extension (`splitQuantities` compares
`shipped * unitCents === extendedCents`, so a credit line needs its quantity negative too, which is
precisely what `IPC_CREDIT` does with `-(\d+)-(\d+)`).

## Not wrong today

`prove-invoices` reports 35 invoices, 35 reconcile, 0 holding no lines, so no invoice on file carries
a credit line on a layout that cannot read one. This is about the next one. Returns to a wholesaler —
short-dated, damaged, recalled — are ordinary, and the owner has already asked about one: *"we got an
invoice credit from IPC did we read it right and apply credit?"* That one arrived as its own credit
note, and was read. The unhandled case is a credit **line on an ordinary invoice**, from any supplier
but IPC.

## For session 1

Two counts from the invoices on file:

1. Does any stored invoice text contain a money figure written with a leading `-` or in brackets on
   a line the reader did not keep? That is the case above, sitting there already.
2. Of the invoices whose lines were discarded for not reconciling, how many are short by exactly
   twice a figure printed on them? That signature is a credit line read as a purchase.
