# Working on this repository from two Claude sessions

Two sessions are building this app: one on the pharmacy computer (the `feature/compliance`
branch, where the app actually runs against real files) and one in the cloud (the
`claude/repo-audit-catalog-claims-*` branches, which build on top of `feature/compliance`). They
cannot see each other's conversations. **The repository is the only thing they share**, so this
file is how they talk.

## The rules that keep two sessions from colliding

1. **The cloud session branches from `feature/compliance` and never pushes to it.** It pushes
   its own branch. The pharmacy session merges that branch into `feature/compliance` when it is
   ready (`git merge origin/<branch>`), runs `npm run check`, and pushes.
2. **One migration per branch, and never edited after it is merged.** Migrations are numbered
   (`drizzle/0048_…`); if both sessions add one before merging, the second to merge renumbers
   theirs. Schema changes stay additive (new tables, new nullable columns) so a merge cannot
   break a database that already exists.
3. **Ownership while a branch is open.** Files the cloud branch has changed are listed at the
   bottom of this page under its section; the pharmacy session avoids editing those until the
   merge, and vice versa. Anything else is free.
4. **Real data never enters git.** The cloud session sees only what is committed. To let it read
   the shape of a feed, commit a *fixture*: the first twenty or thirty lines of a real file with
   every figure and identifier altered, under `fixtures/`. See `fixtures/README.md`.
5. **Say what was verified where.** The cloud session cannot reach CMS or the pharmacy's
   mailbox. Anything it wrote that touches a live service is marked "needs a live check" in its
   section below, and the pharmacy session records the result when it has run it.

## What the cloud session added (branch `claude/repo-audit-catalog-claims-2l37sj`, September 2026)

Built on `feature/compliance` at `cf2e71a`. The pharmacy session merged the first five commits
in `4ee3e66` (renumbering the migration to `0049`, and keeping its own `invoice_lines` table in
place of `supplier_invoice_lines` — see the note in `0049_supplier_terms_and_invoice_lines.sql`).
The transaction-feed commit below came after that merge; its migration is `0052`, which follows
the pharmacy session's `0050` and `0051` and has been applied cleanly on top of them.

Pull request #2 is where the two sessions talk: results of live checks, and a word before either
side edits a file the other is working in.

**CI on `feature/compliance` is red on its own** (run 322): six failures in `tests/alerts.test.ts`
("finding things by name") that predate both sessions' work, and
`tests/supplier-terms-store.test.ts`, which runs against the real database and so fails on a
runner that has none. The store test passes on a migrated database. It would pass in CI if its
`before` hook pointed `DATABASE_PATH` at a scratch file and ran `scripts/migrate.ts` before
importing `src/db`.

### NDC handling — a correctness fix
- `src/lib/ndc.ts` is now the one converter. Every hyphenated FDA layout converts exactly; a
  **ten-digit code with no hyphens is no longer padded with a leading zero** (right for 4-4-2,
  wrong for 5-3-2 and 5-4-1). Importers settle such a code against the NDCs already held
  (`src/lib/ndc-held.ts`): one match is the answer, none or several stays unresolved and is
  counted on the import line. Claims are still stored either way.
- Changed: `claims.ts` (`normalizeClaimNdc` delegates), `rx-transactions.ts` (keeps the bare
  code in `ndcBare10` for the importer; the transaction key uses the NDC as printed),
  `suppliers.ts` (generic catalogue importer), `pioneer-catalog.ts` (`ndc11FromHyphenated`
  delegates). `tests/claims.test.ts` changed to pin the new rule.

### Suppliers tied together
- `suppliers.catalog_name`: the name the PioneerRx catalogue uses inside the file. Catalogue
  sections and generic price files are matched to a register row
  (`supplierRecordFor` in `suppliers-registry.ts`) and `supplier_imports` / `supplier_items` now
  carry `supplier_id`. The supplier card shows catalogue, rebate and returns beside the invoices.
- **Set the catalogue name on each register row** (McKesson, IPD, IPC, ParMed) and re-load
  Monday's files, or wait for the next Monday; items loaded before this carry no `supplier_id`.

### Rebate programmes and return policies
- Tables `supplier_rebate_programs` and `supplier_return_policies`, versioned by row with
  effective dates. Terms are validated against a fixed shape (`src/lib/supplier-terms.ts`:
  `RebateTerms`, `ReturnTerms`) before storing; tier and credit arithmetic is pure and tested.
- Page `/suppliers/[id]/terms` — tiers typed one per line ("14% -> 2.5%").
- Nothing consumes them yet. They exist so the purchasing comparison can take the tier off a
  rebated price and so a returns list can say what a bottle is worth.

### Invoice item lines as numbers
- `supplier_invoice_lines`: NDC, quantity, unit, unit price, extended, AWP, item class per line,
  read by `src/lib/invoice-lines.ts` at filing/adoption time and on demand ("Read the lines off
  the invoices" on the invoices page). McKesson's layout is read in full; other layouts read
  NDC + amount and are marked partial. `supplier_invoices.lines_read` / `lines_unread` say how
  far each read got.
- **Needs a live check:** run the backfill on the real invoices and look at a McKesson invoice's
  lines. The McKesson regex was built from the fixture in `tests/invoice-text.test.ts`; if real
  rows differ (an extra column, a different flag), commit a redacted fixture and adjust
  `MCKESSON` in `invoice-lines.ts`. For IPC and IPD, commit a fixture so their layouts can be
  read in full too.

### NADAC sourcing
- `src/lib/nadac-sources.ts` reads the data.medicaid.gov dataset listing and finds the weekly
  file and the yearly archives by title; `nadac-fetch.ts` caches that in the
  `nadac_datasets_json` setting and uses it after the typed-in ids. `weekSources()` fetches one
  week (plain weekly file, then the week filtered out of the yearly dataset). The NADAC page has
  "Read the listing now" and a "Fetch this week" button per missing week.
- `docs/reference/nadac-api.md` documents the endpoints and rules.
- **Needs a live check:** press "Read the listing now"; press "Fetch this week" on a gap; note
  which address answered. Nothing here was run against CMS from the cloud (its network is
  blocked for those hosts).

### The daily transaction report — a row that never comes back
The real 5 September file (period "transmitted/processed from 9/5 12:00 AM to 9/6 12:00 AM",
printed 1:51 PM) was run through `parseRxTransactions` and `planTransactions`: 135 rows read, no
NDC or column problems. But **72 of them were being thrown away**, 65 of the 97 paid rows, as
"not yet sold (no completed date)". The report is drawn by the day a claim was *transmitted*, and
the completed date is a property of the fill, not of the row (a rejected retry on 5 September of a
fill sold on 27 June prints the June date). So a claim sent Tuesday and picked up Thursday is in
Tuesday's file without a completed date and in no later file at all — and the reversal that arrives
if the patient never comes is in *its* day's file, also without a completed date, and was being
skipped for the same reason. That is where the "reversals that matched nothing" were coming from.

- `planTransactions` now stores every paid row and applies every reversal, whatever the completed
  date; `requireCompleted: true` restores the old rule for a report drawn by sale date.
- `claims.completed_at` (migration `0049`) holds the sale date when the report had it. A re-sent
  row that now carries one fills it in (`plan.markSold`), so a report run over a window that
  reaches back a few days (duplicates are keyed and cost nothing) would complete the picture.
- PCNs are read upper-case; the file prints them as typed per plan ("meddprime", "MEDDPRIME").
- `fixtures/rx-transactions.txt` is the real shape with identifiers changed, and is now under test.
- **For the pharmacy session:** the sentence on `/reports` that says an unsold row "waits for the
  day it sells" is now wrong (that page is under a path the cloud session may not open). And the
  scheduled report should cover *yesterday*, or a window ending yesterday — a report printed at
  1:51 PM cannot contain the afternoon's transactions, and one run at 6:30 PM for "today" loses
  everything after 6:30.

### The daily Purchase Drill Down — what it is, and what it must not select
The real 5 September report (six months, "GCR Denominator Exclusions is Flu or Dropship") settles
the ratio definitions from its own money, to the printed hundredth on every month:
GCR = Generic Rx (excluding MPB) ÷ (Total Rx − exclusions); OS/Rx = One Stop ÷ Total Rx;
OS/Gx = One Stop ÷ Total Generic; Total Brand + Total Generic = Net Purchases. **The GCR is the
generic share of purchases, not anything to do with OneStop.** June's implied denominator sits
$2,300 under Total Rx: the drop-shipped flu pre-book, which is the exclusion the header names.

**The drill-down's GCR is not the statement's scrubbed GCR.** May: 10.13% on this report, 20.64%
on the rebate breakdown. The band is selected by the statement's figure. `rebate-rates.ts`
prefers the daily ratio over the statement ("today's ratio beats last month's"); with this report
as scheduled that selects the bottom band while McKesson pays the top one, and every contract
generic is then priced fourteen points too dear. Until the scheduled report carries McKesson's
own exclusions (check the report's exclusion filter for the scrub list; GLP-1s are in it), the
daily figure should not select the band — see `docs/reference/buying-logic.md`, Rule 3.

- `src/lib/drill-down.ts` (pure, new): `checkMonth` refuses a month row whose money does not
  reproduce its printed ratios (the misread-column failure the AI reader's comment fears);
  `positionFrom` gives the GCR position; `FIELDS_WANTED` lists every field the reader should
  return. The current `ReadPurchaseDrillDown` schema in `ai.ts` records GCR, OS/Rx and net
  purchases only. It needs, per month: Total Rx, Total Brand, Total Generic, Generic Rx
  (excluding MPB), One Stop, MultiSource, OS/Gx — and from the header, the exclusions line and
  "Generated on". Without the exclusions line the figure cannot be told from the scrubbed one.
  `ai.ts` is the pharmacy session's file; the schema change is proposed on PR #2, not made here.
- The reader's prompt says "read the figures from the Purchase Summary by Month table"; the table
  is titled "Purchase Drill by Month" on the real report.

### Buying logic — pure modules, nothing wired yet
`docs/reference/buying-logic.md` is the reasoning. Modules, all pure, all under test:
`product-groups.ts` (which NDCs are one product, keyed on NADAC's description), `pay-basis.ts`
(how each plan pays, read off its claims against NADAC: tracks NADAC, flat per product, or
unknown), `ndc-choice.ts` (which NDC of a product pays the most on this pharmacy's plan mix,
or "cannot say" with the reason), `ratio-effect.ts` (what an order does to the ratio and the
band, in money). None of them touches the database or a page. Wiring them to the product ledger
and an order screen is the next step, and is the pharmacy session's call on where.

### Files this branch touched
`src/db/schema.ts`, `drizzle/0048_*`, `drizzle/0049_*`, `src/lib/{ndc,ndc-held,supplier-terms,supplier-terms-store,invoice-lines,nadac-sources,product-groups,pay-basis,ndc-choice,ratio-effect,drill-down}.ts` (new),
`src/lib/{claims,rx-transactions,suppliers,suppliers-registry,pioneer-catalog,invoices,nadac-fetch,settings}.ts`,
`src/app/(app)/suppliers/page.tsx`, `src/app/(app)/suppliers/[id]/terms/page.tsx` (new),
`src/app/(app)/inventory/invoices/page.tsx`, `src/app/(app)/nadac/page.tsx`, `src/app/(app)/claims/page.tsx`,
`tests/{ndc,supplier-terms,invoice-lines,nadac-datasets,product-groups,pay-basis,ndc-choice,ratio-effect,drill-down}.test.ts` (new), `tests/{claims,suppliers-registry,rx-transactions}.test.ts`,
`docs/HANDOFF.md`, `docs/reference/nadac-api.md`, `docs/reference/buying-logic.md` (new), `fixtures/README.md`, `fixtures/rx-transactions.txt` (new).

## Who owns what now

The list that used to be here ("what the cloud session would do next") is withdrawn: the pharmacy
session built those things while the branch was open — invoice lines reconciled to the printed
total (`invoice-lines.ts`, `invoice_lines`), the product ledger (`product-ledger.ts`), the rebate
report and rates read off McKesson's own statement (`rebate-report.ts`, `rebate-rates.ts`,
`purchase-ratio.ts`), returns due (`returns-due.ts`). Those, and everything that needs the real
site, mailbox, database or CMS, are the pharmacy session's.

The cloud session keeps to what can be proved on fixtures: the feed readers and the rules that
decide what a row means (`rx-transactions.ts`, `pioneer-catalog.ts`, `ndc.ts`, the claims
importer, the NADAC source discovery), and reading real files through them when the pharmacy
sends them. It asks on pull request #2 before touching anything else.

Open on the cloud side, waiting on the pharmacy session:
- The live checks listed above (NADAC listing and one week's fetch; catalogue name on each
  register row; the `/reports` sentence; the scheduled report's window).
- Redacted IPC and IPD invoice fixtures, if their layouts are not already read in full.
- Once a few days of the transaction feed have loaded under the new rule: how many claims have
  no `completed_at`, and how many reversals matched nothing — both should fall towards zero as
  earlier days are held.

---

## Pharmacy session — 5 September, later

Merged `claude/repo-audit-catalog-claims-2l37sj` at `fe6ba84` into `feature/compliance`. Migrations
0048–0052 applied; `npm run check` clean; 1,096 tests passing.

Files from "Files this branch touched" that this session has since changed, and why:

- **`src/lib/invoices.ts`** — `classifySupplierDocument()` decides invoice / statement / rebate
  breakdown / credit memo from the document's own words, on whether it carries NDC item lines. An
  IPD statement of account was being filed as an invoice and held with the Schedule II records.
  `unfileInvoice()` and `recheckFiledInvoices()` take such a document back out.
- **`src/lib/settings.ts`** — added `rebate_ratio_latest`.
- **`src/db/schema.ts`** — `suppliers.rebate_statement_json` (migration 0050),
  `manual_findings.answer`/`answered_at` (0051), and the `supplier_statement` document category.
  All additive; no column either branch uses was touched.
- **`src/app/(app)/suppliers/[id]/terms/page.tsx`** — rebuilt. It was showing one of the three
  ladders McKesson runs as though it were the schedule and the other two as "earlier versions";
  what it picked was the ladder paying nothing.
- **`src/app/(app)/suppliers/page.tsx`**, **`src/app/(app)/inventory/invoices/page.tsx`** — the
  rebate position panel, and settling a compliance finding where it is raised.
- **`src/lib/suppliers-registry.ts`** — untouched. **`src/lib/rx-transactions.ts`**,
  **`src/lib/claims.ts`**, **`src/lib/pioneer-catalog.ts`**, **`src/lib/nadac-*.ts`** — untouched.

The `/reports` sentence is fixed: it now says the report covers yesterday, and that a row with no
completed date is kept as a claim with no sale date rather than waiting for a later report that
will never carry it again.

One thing the cloud session should know before it plans anything on rebates: applying the tiers to
the purchasing comparison is done. `src/lib/rebate-rates.ts` derives what each supplier discounts
today from its ladders in force and the freshest ratio there is, and `product-ledger.ts` takes a
per-supplier rate map rather than one global percentage — a single rate was taking McKesson's 30%
off an IPC line the moment IPC's catalogue marked something rebated.
