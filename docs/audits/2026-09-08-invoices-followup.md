# The invoice findings, four merges later: one fixed, three still open

*Helper B (cloud, Session 2's helper), 8 September 2026, on `feature/compliance` at `103bc90`.
Following up `docs/audits/2026-09-08-invoices.md` and `-supplier-matching.md` after `work/invoices`
merged four more times. Every line below was reproduced by running the code.*

## Fixed, and fixed better than I asked

**`unplacedLines` / `unplacedCents` / `unplacedNames` are on a screen.** They are on the suppliers
page, above the figures they invalidate, saying *"Nothing below counts them — not the purchases,
not the ratio, not the rebate"*, with the printed names listed and an instruction to add them. That
is the whole of the finding and more: I asked that the number not be dropped on the floor, and what
landed tells the owner what the number means for the figures beside it. Nothing further from me.

## Still open

### 1. The alias the owner types to fix a match is the one spelling that cannot match

`normaliseAliases` splits on `,` as well as newline and `;`. So an alias typed exactly as the
invoice prints it comes apart:

```
"MCKESSON DRUG CO., INC."            -> ["MCKESSON DRUG CO.", "INC."]
"AMERISOURCEBERGEN DRUG CORP., LLC"  -> ["AMERISOURCEBERGEN DRUG CORP.", "LLC"]
"IPC (INDEPENDENT PHARMACY COOPERATIVE), INC" -> ["IPC (INDEPENDENT PHARMACY COOPERATIVE)", "INC"]
```

And then, with `supplierRecordFor` matching by equality as it now correctly does:

```
printed "MCKESSON DRUG CO., INC."  ->  NO MATCH
printed "MCKESSON DRUG CO."        ->  McKesson
printed "McKesson"                 ->  McKesson
```

The full printed name — the one the owner would copy off the invoice into the alias box precisely
because it is what the page says — is the one that fails. The two halves match; the whole does not.

There is a second cost: `"INC."` and `"LLC"` are now aliases in their own right, and equality
matching will hand any document printed as `INC.` to whichever supplier sorts first. A company
suffix is not an identifier.

The registry's own field says *"One alternate spelling per line"*, so the newline is the separator
the design intends; `,` and `;` were an accommodation that now defeats the fix they predate. The
change is to `normaliseAliases` alone, and `suppliers-registry.ts` is 2's.

### 2. `adoptDocument` still files an invoice with a total and no lines without a word

`emptyInvoiceWarning` has exactly one caller, `fileInvoice` at `invoices.ts:678`. `adoptDocument`
— the path that files a document already held, and the one `adoptAll` presses in bulk — sets

```ts
needsReview: !(fromText?.confident ?? false) && schedule === "unknown",
```

which is about the *schedule*, not about whether the invoice carries any lines. So an invoice
adopted with a total and nothing under it is filed clean: it counts as cost of goods, contributes
nothing to purchases by item, and carries no flag saying why the two disagree. That is the same
shape as the unplaced-lines bug — a figure that is wrong in a way nothing says out loud — and
`adoptAll` means it can happen to a stack in one press.

Query 3 under "Open items" sizes it: invoices with a total, no lines, **and `needs_review = 0`**.
That second number is the one actively lying.

### 3. The two matchers still disagree, and they fail in opposite directions

`supplierRecordFor` (equality, six ladders) and `rateForSupplier` (containment, guarded at
`SHORTEST_MATCH = 4`) both still exist and still answer differently. Run side by side:

| printed name | `rateForSupplier` |
| --- | --- |
| `ipc` | IPC terms |
| `ipc (independent pharmacy cooperative)` | **NO RATE** |
| `mckesson` | McKesson terms |
| `mckesson drug co., inc.` | McKesson terms |

The guard exists so that a three-letter fragment cannot swallow an unrelated name, which is right.
Its cost is exactly and only the pharmacy's short-named secondaries: a longer printed name can
never reach a rate key shorter than four characters, so **IPC and IPD are the two suppliers this
silently misses**, and they are the two the buying logic cares most about.

Put beside finding 1, the directions are opposite and they compound. An invoice printing
`IPC (INDEPENDENT PHARMACY COOPERATIVE), INC`:

- `supplierRecordFor` fails, because the alias that would have matched was split at the comma;
- `rateForSupplier` fails, because `ipc` is under the guard.

Filed against no supplier, and earning no rate, from one document, for two unrelated reasons.

## What I have not done

`suppliers-registry.ts`, `invoices.ts` and `supplier-match.ts` are 2's. I have edited none of them,
and none of the three needs a decision from me — each is a change in one function with a test
beside it. Queries 3, 6, 8, 9 and 10 under "Open items" size all three; **query 10 stays the
precondition** — aliases must be filled before anything else moves, or a match that works today
becomes a null tomorrow.

Still no McKesson invoice anywhere in the repository, so the McKesson reader in `invoice-lines.ts`
has still only ever run against a hand-built string.
