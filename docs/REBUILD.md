# The rebuild — engineering spec

The owner's reading copy, with the diagrams and his Fate choices, is the Claude doc
"The rebuild, thought through" (1 October 2026):
https://claude.ai/code/artifact/4436073d-6594-4f2f-8527-b274d3517429. This file is the build
spec a session works from. Where the two disagree, the doc is what he agreed to and this is wrong.

## The one rule

A screen shows only what was computed when the data arrived and proven against its source. It
asks only when a rule cannot decide, and the answer becomes a rule. Everything else follows.

## What stays, what changes

Stays, untouched: the database and every table; every reader under `src/lib/` (3 held of 433
September emails); the mailbox, SFTP, MTF CLI, NADAC and backup jobs; the placement engine in
`bank-statement.ts` / `bank-match-context.ts` / `bank.ts` (89 → 2 on September's statement).

Changes: a new engine layer of computed tables; five screens under a new route group; the old
pages behind *More* until each one's job is on a new screen, then deleted.

His Fate choices (doc table, 1 Oct): everything folds into the five screens except — Later:
Kansas floor and appeals, returns, supplies; Drop: who pays best, which contract (replay),
report check, extra sections, NADAC page, activity log page, PioneerRx SQL tool, find, finish
setting up. **Keep in stage 2:** secondary-supplier add-ons ("Order from", under Money ·
Suppliers) — he set it to Keep himself.

## Engine tables (compute on write, rebuilt nightly)

All under `src/lib/engine/`, each with one writer, one nightly full rebuild, and a comparison of
the incremental copy against the rebuild that is itself a proof.

| Table | Row | Written when |
|---|---|---|
| `needs_you` | one line a person must answer: kind, consequence rank (patient harm > board/DEA > payer > money by amount > convenience), the one-press answers that fit, the rows behind it, resolved_at | any ingest, any rule learned, nightly |
| `claim_receivable` | one per claim inside the books: expected, received, outstanding, age, payer cycle, state (inside_cycle · due · short_paid · overpaid · paid_on_reversed · never_measured · settled) | 835 import, claims import, nightly |
| `payer_ar` | one per payer: bands 0–14 / 15–30 / 31–60 / 61+, due, measured cycle (p50, p90, n), channel | from `claim_receivable` |
| `payer_cycle` | per payer: p50/p90/n over the last 90 days of tied payments; null under 25 | nightly |
| `month_status` | per month: bank opening/in/out/closing, lines placed/open, receipts-to-bank gap named, proofs passed, close state | any placement, nightly |
| `feed_state` | per expectation: arriving / not_yet_due / due_now / overdue / never_arrived / not_expected (expected.ts) | sweep, nightly |
| `proof_run` | per proof per night: pass/fail, figures, the rows that failed | nightly |
| `rules` | every learned answer: kind (cheque payee, vendor category, alias, sender+shape, counter run), key, value, said_by, said_on | each answer |
| `aliases` | name as one document prints it → the name the ledger uses (SS&C ↔ Argus, WholeScripts ↔ Xymogen, 835 payer ↔ plan) | answers, imports |

Budgets: ≤ 3 queries per screen, all against engine tables; first paint < 300 ms on the pharmacy
computer; no client script except the answer forms; a test fails any screen that imports a
store module directly.

## Proofs (nightly, written to `proof_run`)

1. Bank to the cent: opening + placed lines = closing; every receipt dated in the month has a
   bank line or is named in transit (register days landing next month, IPD credit memos).
2. Claims = PioneerRx (claims-completeness, already computed nightly; now surfaced).
3. Every reader's arithmetic (already gates storage; the proof counts the held ones).
4. 835 → claim: in-books payments tied, by count and money; the residual listed.
5. Expected → arrived: every expectation judged; overdue becomes a Today line.
6. Engine incremental = engine rebuild.

## Matching, in order, each exact or nothing

Document's own reference (McKesson ACH number, payment number) → the supplier's statement group
(invoices due D on statement S less S's credits, paid invoices excluded) → learned cadence
(`datesDrawnOn`) → exact set among invoices/receiving (`invoicesPaidBy`, refuses ambiguity) →
register runs for counter deposits → remittance sets for PSAO deposits (nearest set wins) → rules
and aliases → nothing. A rule places only when exactly one answer fits.

Learning: `decideBankLine`, `cheque-expectations.ts`, and the rules/aliases tables. Re-reading:
`replaceUnplaced` nightly over the last 90 days of unplaced lines; the inbox re-read over held
items when a reader changes (keyed by reader version).

## Screens

Today · Money (Bank, Suppliers incl. Order from, Remits, Spending, Deliveries, Close, Cash
ahead) · Claims (Aged AR by payer, Unpaid scripts, Short-paid by reason, Unmatched, Payers) ·
Compliance (Register, Temps, CQI, Controlled incl. perpetual C-II, Staff, Manual, Inspection) ·
Documents (Arrived, Held, Add, Search, Forms). Settings behind a gear (details, connections,
email, backups, updates, data: pack sizes, aliases, rules).

Each opens on six numbers and a list; every number links to its rows; no paragraphs; a state is
a chip; the paper/ink/green palette stays. Today works on a phone.

## Build order and gates

1. Engine tables + nightly rebuild + Today. Gate: Today < 300 ms; its list equals the open items
   on the registers; October's feeds judged correctly.
2. Money month view with the answers on screen, Cash ahead, Order from. Gate: September closes
   from the screen with the two cheques as its only questions; October's statement places
   ≥ 158 of its lines without a person.
3. Claims: AR by payer, unpaid scripts, short-paid, unmatched, payer pages. Gate: due list agrees
   with the measured cycles; the OptumRx 182 explained; DST channel set.
4. Compliance consolidated (+ perpetual C-II, retention clock, the full duty register) and
   Documents. Gate: every current compliance page's data reachable; CQI, temps and CS alerts fire
   on their regression cases.
5. Retire: old pages removed, nav final. Gate: a month with no visit to a retired page.

Each stage: full suite green, `tsc` clean, deployed behind the connection gate, proven on live
September and October data, recorded in `docs/HANDOFF.md`.

## Things he has not asked for that the data already supports

Cash ahead (14/28-day outflows vs inflows), recoupments tied to claims (PLB/CAS), short-paid by
reason with the contract rate beside it, perpetual C-II (invoice lines − claims vs counts),
sales tax collected vs remitted, cash-short by drawer and day, a month-end pack for him (never
sent anywhere), rebate expected vs received, a retention clock on every document, the complete
duty register (DEA/state renewals, Medicare revalidation, NPI/NCPDP, immunisation protocol,
HIPAA/OSHA training, waste contracts, self-inspection, insurance, CE), and one request to
ProviderPay for SFTP delivery to end the monthly manual pull.

## Decisions still open (his)

DST Pharmacy Solutions' channel; the OptumRx 182 past-cycle claims; a ten-second cheque form;
cheques 2453 and 2456; go.
