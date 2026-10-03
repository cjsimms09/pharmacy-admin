# A sweep for wide reads, not another guess

9 September 2026 · Helper A · branch `work/wide-reads`

Third pass of the speed work the owner asked for. The first two passes are
`docs/audits/2026-09-08-speed.md` (on `work/rebate-month-once`, pull request #27, with #28 for the
claims table).

**My eye had been wrong twice.** I went looking for a missing index and found the fault was reading
the same rows six times; then I assumed the claims table was fine and found it reading every column
of forty-two. So rather than pick a third candidate by reading code where I expected a problem, I
enumerated **every** `findMany` and `findFirst` in the codebase against a table over a thousand rows
and ranked them by the rows the query can touch. 110 call sites.

## The largest group by count is not a problem, and ruling it out came first

Around forty of the unnarrowed reads are on `documents`. That table stores a `storage_key` — the
file itself lives on disk — so every one of them is a cheap metadata read on about 3,000 rows.

That removed two thirds of the list before anything was measured, which is the point of doing the
inventory before the work: the biggest pile is not the biggest cost, and there was no way to know
that without looking.

## Four were reading a whole table with every column

| | table | rows | why it matters |
| --- | --- | ---: | --- |
| `product-ledger.ts:324` | invoice lines, no `where` | 45,782 | warmed on every cold start; under the buy list and the drug pages |
| `returns-due.ts:246` | invoice lines, no `where` | 45,782 | the returns page |
| `payer-map.ts:147` and `:477` | claims, no `where` | 30,000 | warmed on every cold start |

Measured in the second pass on the same shapes: reading every column against only what is used is
roughly **twice** the cost on the claims table, and about **two and a half times** on the invoice
lines. All of it blocks the web server — the connection is serialized and no page is served while a
query runs.

**Every one of them already had a type declaring exactly what it needed.**
`LedgerInput.invoiceLines` names six of the fourteen columns. `ReturnsInput.lines` names eight. Both
payer-map readings build a `ClaimRow` from nineteen of the claims table's forty-two. The reads now
match those declarations, and in payer-map the list is named once and shared by both so the two
cannot drift into reading different things for the same row.

## The pattern worth keeping

**Two of the four were missed by an earlier efficiency pass, in the middle of its own work.**

`product-ledger.ts:324` sits between two neighbours whose comments explain at length how carefully
each was narrowed — the held catalogue above it, the grouped NADAC read below, each with a paragraph
about why the naive version was unusable — and the line between them read every column of all
forty-five thousand invoice lines.

`returns-due.ts` narrows its claims read on the very next line and not its invoice lines.

The wide read hides beside the fixed one. A sweep finds those; reading the code where you expect the
problem to be does not.

## Left alone deliberately

`plans.ts:302` (`inScopeClaims`) and `appeals.ts:110` hand their rows to callers that decide what to
use, so narrowing them changes a public shape rather than an internal mapping. That is a judgement
for whoever owns them, not a mechanical fix, and it is named here rather than done quietly.

## Still open, and not mine

- `drug-directory-store.ts:64` — all 217,773 rows, every column (session 1).
- `suppliers.ts:459` — all 63,809 catalogue rows (session 1).
- `loadDrugDirectory`'s **430 MB peak**, which remains the largest single number anywhere in the
  site: `docs/audits/2026-09-08-memory.md`.
