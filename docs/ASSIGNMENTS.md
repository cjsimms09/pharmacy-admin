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

A and B cannot reach the pharmacy computer, cannot be messaged by it, and **cannot see the
database, the real screens or the real files.** That was established by measurement (thirteen
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
| **B** | `mailbox.ts` (routing and recognition only), `src/app/(app)/inbox/**`, `labels.ts`, `autoroute.ts`, `intake-*`; audit files under `docs/audits/` |

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

Write each audit as `docs/audits/2026-09-DD-<module>.md`: what is wrong, why it matters in
dollars, the line, and **the query 1 should run on the real database to size it.** Open a pull
request. Findings, not fixes — a fix you are sure of goes in the same pull request as a separate
commit, clearly marked, for 1 to take or leave.

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
