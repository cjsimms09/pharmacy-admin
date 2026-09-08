# Who is working on what

Four sessions build this site. Two run on the pharmacy computer and can see the real database; two
run in the cloud and cannot. The owner names them **1, 2, A and B**.

| Session | Where | Sees real data | Role | Helper |
| --- | --- | --- | --- | --- |
| **1** | pharmacy computer, `C:\Users\wwfprx\pharmacy-admin`, branch `feature/compliance` | yes | **Lead.** Reviews everything, merges, deploys. In charge of the site. | A |
| **2** | pharmacy computer, worktree `C:\Users\wwfprx\pharmacy-admin-invoices`, branch `work/invoices` | yes | Builder on the invoice pipeline. Hands finished branches to 1. | B |
| **A** | cloud, own `claude/…` branches | **no** | 1's helper: **auditor** of the buying and pricing logic, and builder of the Money books | — |
| **B** | cloud, own `claude/…` branches | **no** | 2's helper: **auditor** of the invoice work, and builder of the inbox recogniser | — |

**Everyone reads `docs/SESSION-RULES.md` first.** The rules below are the ones that keep four
sessions from doing the same work twice or undoing each other's.

## How the sessions talk

There is no shared conversation. Each pair has exactly one channel, and it is the only one that
counts:

| From → to | Channel |
| --- | --- |
| 1 ↔ 2 | Direct messages between the two sessions on the pharmacy computer. |
| 1 → A, 2 → B | **A dated instruction under the helper's heading in this file**, committed and pushed. The helper reads this file when it starts and after every pull. The owner may paste a kickoff prompt, but the instruction lives here. |
| A → 1, B → 2 | **A branch and a pull request against `feature/compliance`**, plus a line under "Open items" in `docs/HANDOFF.md`. An audit is a file `docs/audits/YYYY-MM-DD-<topic>.md` on that branch. |
| Anyone → the owner | Findings in plain sentences with the money attached, in the pull request description. |

A and B cannot reach the pharmacy computer and **cannot see the database, the real screens or the
real files.** A runs on the owner's account, so session 1 can send it a one-way message; **B runs on
a different Claude account**, so nothing reaches B except this repository and what the owner pastes
— the git channel above is B's only channel, in both directions. That was established by measurement (thirteen
hosts tested; every tunnel refused). Do not propose a tunnel, a hosted copy or emailed files. A
question that needs real figures is written as a query under "Open items" in `docs/HANDOFF.md`, and
1 or 2 runs it and writes the number back.

## No double work

- **One owner per file group.** The table below says who edits what. Touching a file in someone
  else's group without a line in `docs/HANDOFF.md` first is the one thing that has already cost this
  project a merge.
- **Builders build, auditors audit, and an auditor's fix is a pull request, not an edit.** A
  finding says what is wrong, why, the number that shows it, and the query that would prove it on
  real data. The builder decides; the lead merges.
- **Measured once.** A figure counted on the real database goes into `docs/HANDOFF.md` with its
  date and its query, so nobody counts it again.
- **Migrations are numbered by whoever merges second.** Session 1 has `0082`. The next free number
  is `0083`; if two branches both take it, the one that has *not* been applied on the pharmacy
  computer renumbers and takes a later `when` (`scripts/migrate.ts` says why the timestamp decides).

## File ownership

| Session | Files |
| --- | --- |
| **1** | `product-groups.ts`, `product-key.ts`, `drug-profit*.ts`, `products-store.ts`, `money-found.ts`, `replay-store.ts`, `suppliers.ts` (catalogue import), `nadac*.ts`, `catalogue-*.ts`, `drug-directory*.ts`, `shelf.ts`, `order-plan.ts`, `scripts/**`, migrations, these docs |
| **2** | `invoices.ts`, `invoice-lines.ts`, `suppliers-registry.ts`, `rebate-rates.ts` (supplier matching), `purchase-ratio.ts`, `src/app/(app)/suppliers/**` |
| **A** | `ledger.ts`, `ledger-store.ts`, `period-account.ts`, `profit-and-loss.ts`, `src/app/(app)/money/**`, `bars.tsx`, `charts.tsx`, `expense-categories.ts`; audit files under `docs/audits/` |
| **B** | `mailbox.ts` (routing and recognition only), `src/app/(app)/inbox/**`, `labels.ts`, `autoroute.ts`, `intake-*`, `era-enrollment.ts`, `src/app/(app)/payers/routing/**`; audit files under `docs/audits/` |
| **1, contracts** | `contract-*.ts`, `src/app/(app)/payers/sort/**`, `payers/contracts/**`, `payers/[pbm]/**` — the contract ingestion is session 1's own job; nobody else edits the extraction |

---

## Session 2 — the invoice pipeline

**Assigned 7 September by 1.** Two facts from the real database, both with money behind them:

1. **No McKesson invoices are loaded.** `invoice_lines` holds 8 lines, $78.50, all from
   "Independent Pharmacy Cooperative", `rebated = null`. Every rebate figure — earned toward the
   McKesson tier, the purchase ratio, `earningSoFar` — runs on nothing. Trace the import path
   (`invoices.ts`, the mailbox route, `invoice-lines.ts`), find what shape a McKesson invoice
   arrives in (`fixtures/`), and find whether the importer recognises it. Fix or build the reader
   against a fixture with every identifier changed, with the arithmetic check: quantity × unit cost
   = extended, lines sum to the total, or the row is quarantined and says so.
2. **The supplier name match drops IPC's lines.** `rebate-rates.ts` matches by containment; the
   register says "IPC", the invoice says "Independent Pharmacy Cooperative", neither contains the
   other, so those lines match no supplier and vanish from every figure. `catalogName` is empty for
   IPC, Mckesson and IPD. Resolve by `supplier_id` where a line carries one, else through a list of
   aliases on the register row (additive migration, `0083`, `when` later than 0082's
   1788806728029). Not another substring guess.

Works in its own worktree, never in 1's folder (a deploy runs `git checkout -- .` there). Hands the
branch to 1 by message when `npm run check` passes. **B audits this branch** — see B below.

---

## Helper A — auditor for 1, and the Money books

### Audit first (7 September, from 1)

The owner's standing instruction: *"Double check all logic to make sure it makes sense — ordering
logic, NADAC, pricing, which supplier to buy from."* Session 1 is building and cannot audit its own
work. You can, and you do not need the database to read arithmetic.

1. **Audit commit `1c8591d`** — product identity now comes from the FDA directory
   (`product-groups.ts`, `drug-profit-store.ts`, `products-store.ts`, `money-found.ts`,
   `replay-store.ts`, tests in `tests/product-groups.test.ts`). The claim: keying on NADAC's
   description merged 10,427 NDCs the FDA says are different products; the FDA
   `equivalence_key` is now primary and the description is the fallback. Check: does every store
   group the same way now, is the brand/generic guard kept for FDA-keyed rows, can a product split
   across the two schemes ever recommend a switch, and is there a path where an NDC with an FDA key
   and no NADAC row still falls out of a group?
2. **Audit `shelf.ts`** (895 lines, the largest module nobody has read), then `order-plan.ts`, then
   the rebate ladder and band arithmetic (`rebate-rates.ts` except the supplier matching, which is
   2's; `band-strategy.ts`; `ratio-effect.ts`), then claim-to-contract matching
   (`claim-contract.ts`), then the cash-versus-accrual split. Read against
   `docs/reference/buying-logic.md` and `data-dictionary.md`: every figure one meaning, one unit,
   never used for what the dictionary says it must not be. Units are the thing that has already
   gone wrong here — a per-EA cost against a per-ML benchmark read as "100× NADAC".

3. **Claims data** (added 7 September, the owner's ask): the claims reader `claims.ts` and every
   column alias it accepts, `fills.ts` grouping, `claim-payments.ts`, and `reimbursement-fit.ts`.
   One meaning and one unit per figure, nothing inferred that the export states, and every figure
   the profit chain uses (`drug-profit.ts`, `contract-replay.ts`) traced back to the export column
   it came from. Session 1 will put the claims inventory it is building under "Open items" in
   HANDOFF so you audit against what the export actually carries.

Write each audit as `docs/audits/2026-09-DD-<module>.md`: what is wrong, why it matters in
dollars, the line, and **the query 1 should run on the real database to size it.** Open a pull
request. Findings, not fixes — a fix you are sure of goes in the same pull request as a separate
commit, clearly marked, for 1 to take or leave.

### Small and first (7 September, from 1): a ladder must say which ratio drives it

Found on the real database: all three McKesson programmes were stored with `ratioMeasure: null`,
so `rebate-view.ts figuresFor()` could pick no figure, no band was ever selected, McKesson's rate
was nothing, and 7,165 contract generics were compared at printed price — about 30% too high (at
the 20.32% compliance on file the OneStop ladder pays 29% and GPR 1%). Migration `0084` sets the
field from each programme's own `ratioDefinition` text. Your part, pure and small, in
`supplier-terms.ts` and `src/app/(app)/suppliers/[id]/terms/page.tsx` (both yours for this):
(a) a `tiered_ratio` programme cannot be saved with a null `ratioMeasure` — the form requires the
choice, in words the pharmacist reads ("your scrubbed generic compliance rate" / "your generic
purchase ratio"); (b) `contractRateDiagnosis` in `rebate-rates.ts` (1's file, yours for this
sentence only) must never say "the band it lands in pays nothing" when the true reason is that no
programme states its measure — say that instead, naming the programme; (c) a test for each;
(d) verified after the fix: McKesson shows 29% contract and 0.75% brand but **`allGenericsPercent`
null** — the GPR ladder reads `a.gprPercent`, which only a monthly statement fills, while the daily
Purchase Drill Down already carries the generic share (`latestRatio().osGxPercent`, 79.8% today,
which pays 1%). Read `rebate-rates.ts ratesFor()` and `rebate-view.ts figuresFor()`, decide
whether the daily figure is the same measure McKesson settles on (the comment block in `ratesFor`
argues this for the compliance rate; say whether it holds for GPR), and if so pass it through.

### Second (7 September, from 1, added after the audit was assigned): the claim-to-contract match

This comes **before** the Money books, because the owner's order is drug file → contracts → money,
and because session 2 measured on the real database that **0 of 1,081 insured claims match a
contract** (full numbers at the top of `docs/HANDOFF.md`). The reason is structural, not a matter
of reading more documents: claims speak in codes — BIN 99.8%, PCN 94.4%, group 95.1%, and
PioneerRx's `networkId` 95.3% across 82 distinct values — while rate exhibits identify themselves by
network name ("Prime AccessOne Network") and chain code ("00605"), with empty BIN/PCN/group.
`claim-contract.ts governs()` matches on BIN/PCN/group only and ignores `networkNames`,
`networkReimbursementIds` and `chainCodes`. `payer_links.contract_id` was created to hold exactly
the missing link and nothing writes it.

**Build the mapping, pure and tested, in `claim-contract.ts` — which 1 hands to you for this job
(HANDOFF line written).** A claim resolves to a contract by, in order: an explicit `payer_links`
row (network id → contract document, set by the owner), a network reimbursement id the document
itself states, then BIN/PCN/group as today. Never a name-similarity guess. Where nothing resolves,
the answer is "unmatched" with the network id named, so the owner can map it on the payers page
with one choice per network id — 82 choices at most, once. Deliver: the resolver with tests for
each rung and for the unmatched case; the page control to set the link (in `src/app/(app)/payers/**`,
which you may edit for this — say so in the pull request); and a report of the 82 network ids by
claims and dollars behind each, which you cannot compute — write the query in HANDOFF and 1 will
run it. Do not edit `contract-terms.ts` or the extraction; read them.

### Then build: one set of books, and no figure counted twice

The owner: *"The money tab needs to have sound logic, needs to not forget about expenses or revenue
it knows, needs to not double count things. This is how I will track financials of pharmacy. It
should be able to operate on a cash and accrual basis."* Two period modules landed the same night
and both are in the sidebar: `period-account.ts` + `periodAccount()` / `monthlyTrend()` +
`/money/report`, and `ledger.ts` + `ledger-store.ts` + `/money`. One must absorb the other; the
proposal on the table is `/money/report` as the surface with `loadShared()` underneath (also a
speed fix: twelve passes over every claim become one). Deliver the fold, a double-count test with a
fixture where the same money is reachable two ways, a completeness check that says out loud which
feeds are not yet in the books, cash and accrual with the difference explained, and a test that the
books balance from the stored rows. Full brief in `docs/BACKLOG.md` item 4.

---

## Helper B — auditor for 2, and the inbox recogniser

### Audit (7 September, from 1; 2 will add to this)

Session 2 is fixing the invoice pipeline on branch `work/invoices` (see above). When that branch
appears on GitHub, audit it: does the reader refuse a row whose arithmetic does not close, does a
supplier ever resolve by substring again, does an invoice line carry one meaning per figure and the
unit it is in, is anything inferred that the invoice states. Write `docs/audits/2026-09-DD-invoices.md`
with findings and the queries 2 should run, and open a pull request. **Session 2 owns this section
from here and will write its own instructions to you under this heading.**

### Before the inbox (7 September, from 1, with the owner's priority): get the 835s sent here

The owner: *"Want to automate request to have 835s sent to this site instead of where they
currently go!"* Session 1 is reading every contract and will extract, per payer, where remittance
advice goes today, who changes it, the form or portal or mailbox that takes the request, the payer
id and the clearinghouse. Your half is **the request itself and its tracking**, in your file group
plus `era-enrollment.ts`, `era_enrollments`, `payment_routing`, `pbm_contacts` and
`src/app/(app)/payers/routing/**` (handed to you for this; say so in the pull request):

1. One generated, ready-to-send ERA/835 enrolment request per payer — the letter or form answers,
   filled from the pharmacy's identifiers in settings (NPI, NCPDP, TIN, the site's receiving
   address and clearinghouse/trading-partner id) and from what the contract extraction supplies.
   Where a payer's form is a PDF the extraction names, the page says so and links it; where it is a
   portal, the page lists the fields to type. Nothing is sent by the site on its own.
2. A state per payer — not requested, request ready, sent (date, how, by whom), acknowledged,
   first 835 received — shown on `/payers/routing`, with the next action in words.
3. Pure and tested: the request builder takes the payer's extracted enrolment facts and the
   pharmacy's identifiers and returns the request text and the missing-fields list. Fixtures only;
   you cannot see real contracts. The extraction's output shape is in `contract-terms.ts` — 1 will
   add the ERA fields there and note the names under "Open items" in HANDOFF.

Then the inbox recogniser below.


### From 2 (8 September) — what the invoice side needs from you

Branch `work/invoices` is on GitHub and merged once already. Two commits to audit: `e78a7d0`
(supplier resolution) and `c87ff57` (empty invoices). Findings to `docs/audits/`, as above.

**Audit these three things in particular, because each is a number that looked right.**

1. `supplierRecordFor` in `suppliers-registry.ts` must resolve a supplier by equality only —
   register name, catalogue name, aliases, then canonical spellings. If you can find any input
   where it resolves on a partial match, that is a finding. The bug it replaced put eight invoice
   lines and $78.50 outside every rebate figure, silently.
2. `earningSoFar` in `rebate-rates.ts` now reports `unplacedLines`, `unplacedCents` and
   `unplacedNames`. Check that no caller drops them on the floor: an unplaced line that nothing
   displays is the original bug wearing a different coat. I have not yet put them on a screen.
3. `emptyInvoiceWarning` in `invoices.ts` decides whether an invoice with a total and no lines is
   flagged. Check the boundaries — a zero total, a null total, a negative total (a credit memo).
   Flagging a credit memo as a missing invoice would be a new wrong number.

**The seam for McKesson routing is on my side and it is already there. Do not edit the importers.**

`invoices.ts` now exports `looksLikeInvoiceFromUnknownSender({ fileName, mimeType, subject,
supplier, text })`. It answers one question: *this PDF reads as a supplier invoice and we do not
know whose*. It files nothing and changes no existing routing.

Why it exists. `looksLikeInvoice` begins `if (!opts.supplier) return false`, so a PDF from a
sender nobody has registered can never be filed as an invoice. McKesson's register row has no
sender address at all — `sender_emails` is empty — so a McKesson invoice arriving this afternoon
would fall through to the general vault as "other" however plainly the page said INVOICE. The
pharmacy would go on believing its purchase records were complete, every figure built on invoice
lines would be short without saying so, and a supplier invoice sitting among ordinary documents is
the outcome 21 CFR 1304.04(h)(1) does not allow.

What I would like you to build in `mailbox.ts`, which is yours and which I have not touched:
where the sender match returns nothing and this predicate returns true, raise the item as
**"an invoice from a sender we do not know"** with the supplier's name as printed on the page if
you can offer one, and a control to attach it to a register row. Attaching should write the
sender address onto that supplier so the next one files itself — that is the "correction kept as a
rule on the sender" in your own brief. Do not file it as an invoice on the strength of the
predicate alone; an unknown sender is exactly when a person should decide.

It is deliberately narrow: the document's own words must classify as an invoice
(`classifySupplierDocument` → two or more lines each carrying an NDC and a price). A subject line
is written by whoever sent the email and is not evidence when the sender is unknown, and a scan
with no text layer answers false rather than guessing. Tests are in `tests/invoices.test.ts` under
"a supplier invoice whose sender is not on the register".

**What you cannot do and should not try.** There is no McKesson invoice anywhere to test against:
`fixtures/invoice-mckesson.txt` has been wanted since before this branch and `git log --all`
confirms it has never been committed, so the McKesson reader in `invoice-lines.ts` has only ever
run against a hand-built string in `tests/invoice-lines.test.ts`. 1 has asked the owner to forward
a real one. Until it exists, build against `fixtures/invoice-ipc.txt` and synthetic text, and say
in your pull request what you could not verify.

**Questions needing real figures** go in `docs/HANDOFF.md` under "Open items" addressed to 2. I
run them here and write the number back. Do not ask the owner to send you a file; your container
cannot reach this machine.
### Build: an inbox that knows what arrived, and can always be corrected

The owner: *"The inbox should eventually be able to know what's coming in based off name, email,
contents but I also need tools on this page to route things exactly where they need to be or tell
system exactly what we received… It needs to be able to handle it all, allow me to tell it what it
received. From there it should know how to use it."* One recogniser that asks every existing
detector (`looksLikePioneerCatalog`, `looksLikeNadacHeader`, contract triage, the routing in
`mailbox.ts`), ranks the answers, and returns what it thinks, how sure, and why in words; the
inbox page showing that and a control to say what the document actually is; the correction kept as
a rule on the sender so next week needs no correcting; and a test that an unrecognised document is
never filed on a guess. Categories today: supplier catalogues, supplier invoices, expense invoices,
claims exports, NADAC files, reimbursement contracts, employee compliance documents, ERA enrolment,
appeals, MTF remittances — designed so a new one needs no rewrite. Full brief in
`docs/BACKLOG.md` item 5. Do not edit the importers themselves; they are 1's and 2's — leave a seam
and say so in the pull request.
