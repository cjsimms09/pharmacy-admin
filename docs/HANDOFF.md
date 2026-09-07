# Working on this repository from two Claude sessions

Two sessions are building this app: one on the pharmacy computer (the `feature/compliance`
branch, where the app actually runs against real files) and one in the cloud (the
`claude/repo-audit-catalog-claims-*` branches, which build on top of `feature/compliance`). They
cannot see each other's conversations. **The repository is the only thing they share**, so this
file is how they talk.

## Open items

Kept current by whichever session last touched it. A line is removed when the other side has done
it and said so on the pull request. The owner reads this too.

### For the pharmacy session (from the cloud session, PR #4 and after)

- **The first live reads failed as "errored" with the reason thrown away.** Fixed: the API's own
  message is recorded in words that say what to do (`explainFailure` in `contract-extract.ts`), the
  per-request page limit is 300 (a scanned page is up to 3,000 tokens; the model takes a million
  in one request), and the folder is sorted before it is read (`/payers/sort`, migration `0071`
  `contract_docs.triage*`) so W-9s and newsletters are never sent to the expensive reader. The
  contracts page (`payers/contracts/page.tsx`) is yours: it would help to show `triage` and
  `triageWhy` on each row and a "Sort the folder" link in its header; the read already skips what
  the sort ruled out.
- **Four more pages under Ordering and Claims** (all mine, none of yours edited): `/purchasing/minimums`
  (Rule 7a, `minimum-filler.ts`), `/purchasing/replay` (Rule 8, `contract-replay.ts`, the McKesson
  renewal), `/claims/appeals` (`appeal-queue.ts`, `appeals.ts`, migration `0072` `appeals`) and
  `/payers/routing` (`era-enrollment.ts`, `era_enrollments`, setting `pharmacy_tin`). Document
  categories gain `appeal` and `era_enrollment` (`labels.ts`). `minimum-store.ts` mirrors the offer
  building in your `buyListNow` rather than editing `shelf.ts`; export an `offersNow()` and I will
  switch to it.
- **Two period modules landed on the same night.** Yours: `period-account.ts` + `periodAccount()` /
  `monthlyTrend()` in `profit-and-loss.ts` + `/money/report` + `charts.tsx` (BarChart, LineChart,
  Movement). Mine: `ledger.ts` + `ledger-store.ts` + `/money` (the books) + `bars.tsx` (Bars,
  Sparkline; renamed from my `charts.tsx` at the merge to keep yours). Both are wired and both are
  in the sidebar (Money → The books, Statement, Reports). One should absorb the other: I propose
  keeping your `/money/report` and `period-account.ts` types as the reporting surface, and my
  `loadShared()` under both — `periodAccount()` and `monthlyTrend()` read every claim once per
  month today (twelve full passes for a year), and `loadShared(months, basis)` + `monthInputs()`
  read them once. Your call; say on the PR and I will do the fold.
- **The site is regrouped** into Today, Money, Ordering, Claims, Remits, Compliance, People,
  Controlled substances, Tools, Settings (`nav.ts`; the test names the order). The money list moved
  to `/money/found`; `/money` is now the books (`ledger.ts`, `ledger-store.ts`,
  `docs/reference/money-ledger.md`), `/money/monthly` takes `?period=2026-Q3` or `2026`, and
  `/api/ledger?period&basis` is the statement as CSV. `Hub` takes explicit `items` for a landing
  that is not a sidebar group (Records). No page of yours was edited except a link on `payers/page.tsx`
  and the `/money` links on Today and Tools.

- **The contract pipeline was audited before the first full run** (`contract-reading.md` §9 has
  the list). What changed under you: `contract_docs.pages` (counted once; the library no longer
  opens every PDF to draw a list), `network_rates.effective_to` and `status` ("active" /
  "superseded"), both in migration `0074`; the read and the sort open files a batch at a time and
  keep a batch under 40 MB; the sort sends at most 40 scans a press. `proposeFromContract` now
  takes the pharmacy's identifiers and the document's text: `governs` (chain code / NCPDP) and
  `quoteFound` per rate; "Apply everything certain" skips a document that is not ours and a rate
  whose quote is not in the text, and lists both. `rateFor` prices only on rows in force on the
  fill date. `/payers/[pbm]` is rebuilt as the counterparty's file (`contract-file.ts`, pure,
  tested). **Your review page `payers/contracts/[id]` should show `quoteFound` and `governs`** on
  each proposal; I cannot read it. The proving document (`fixtures/contracts/proving-agreement.pdf`)
  and "Prove the reader" on the Sort page mark a live read against a known answer.
- **The live refusal was the reader's own request, and we both fixed it the same night.** "Ask the
  API why" printed it: `invalid_request_error: Schemas contains too many parameters with union
  types (104 …, limit: 16)`. Your fix (`.optional()` on the wire, `fillNulls` on this side, the
  grammar kept, `schema-limits.test.ts`) is the one in force after the merge; mine (the schema in
  the prompt as words) is folded away. What survives of mine: `termsFromObject` /
  `termsFromAnswer` in `contract-terms.ts` are the one place a draft or an answer becomes terms
  (your null-dropping and defaults moved into them from the extract file), the answer is found
  between its first and last brace so the proving read parses too, and `RateTerm.lineOfBusiness`
  is `.optional()` like its neighbours.
- **What to buy is the secondaries only, and it no longer invents a basket.** The owner's brief:
  list what to order from each secondary to reach its minimum, McKesson off the list, the
  supplier's item number on every row, and "it doesn't know what's in our cart". So `/purchasing`
  is one card per non-primary wholesaler: "Order these" (short and cheapest there) and then "Next
  best to add, soonest needed first" — every qualifying generic one pack at a time, fewest days on
  hand first — in one ranked table with a running total, so the line at which the minimum is
  reached is visible without arithmetic. The site cannot see the cart at the wholesaler's website
  and does not pretend to: it ranks, the pharmacist orders. The greedy filler still exists
  (`fillMinimums().picks`) but the page shows `candidates` instead;
  `minimum-store.ts` counts only the planner's `need` lines as spoken for, so the planner's own
  top-ups appear in the ranked list rather than as a decision already made. `/purchasing/minimums`
  redirects here and is off the family tabs. The comparison cards ("Buy these instead", "What each
  drug earns", opps) moved to `/purchasing/products` ("Which NDC pays"), a tab in the same family.
  **The item number is new plumbing through your files**: `supplier_items.item_number` (in my
  migration `0078`), read by both catalogue importers in `suppliers.ts` (`COLUMNS.itemNumber`
  aliases; the PioneerRx path already had it in `pick`), carried by `catalogue-cache.ts`
  (`CatalogueRow.itemNumber?`), `shelf.ts` offers, `order-plan.ts` (`Offer` and `PlannedLine`),
  and `minimum-filler.ts`. It fills in on the next catalogue import; until then every row shows a
  dash with a title saying why. Also `shelf.ts`: `shortestLead` is at least one day (a zero lead
  time made the target window zero and nothing short), and the contract flag maps through
  `contractFlagOf`. The supplier terms field is now labelled "Lead time, in days" with what it
  does — the owner read "Days from order to shelf" as meaningless.
- **"Is everything arriving?" under Settings** (`/settings/feeds`, `feeds.ts`, `feed-rules.ts`,
  all mine). The owner asked how to verify every feed is working — NADAC current, MTF payments
  found, catalogues up to date. One row per feed: cadence, newest row in the table it fills,
  state judged from that row and never from a job's own claim to have run, a proof where one
  exists (claims on every open day, share of two-to-ten-week-old fills with an 835 line, payers
  and suppliers gone quiet, a price file too small to be whole), and a live check on request
  (CMS's newest as-of against the held file, mailbox login, Claude, the facilitator's tool). Your
  `automation-status.ts` is read for the sensors and the backup rather than duplicated. Today
  shows a notice when any feed has stopped.
- **Migration renumbered three times: mine is `0078_standing_costs_terms_pages_tax_bank_items`**
  (`standing_costs` with `paid_day`, `contract_docs.pages`, `network_rates.effective_to`,
  `suppliers.payment_terms_days`, `sales_months.retail_tax_cents`, `bank_lines`,
  `supplier_items.item_number`), after your `0074`–`0077`. Regenerated from the schema, applied
  to a fresh database. The reader is yours as merged at `32803b1` (the shape in the prompt,
  `toWire`/`fromWire`); `termsFromAnswer` reads the wire shape first and the readable shape as a
  fallback, so the proving read and older drafts still parse.
- **The cash account had no cost of goods** because `supplier_invoices.paid_on` was on no screen.
  Now: the invoices page has a Paid column (a date per row, inside the table's one form), the
  supplier's terms page has "paid how many days after the invoice" (`suppliers.payment_terms_days`,
  migration `0074`), and the cash cost of goods counts an invoice by its recorded payment date, else
  its date plus the terms, else its date, and says on the line how many are on an assumed date. It
  is never nought for want of a date. Rule in `money-ledger.md` §2.
- **Standing monthly costs** (`standing_costs`, same migration): payroll, rent, the loan, typed once
  on Money → Spending; the month carries its share by calendar day (`standing-math.ts`, tested) and
  drops it where a bill from the same vendor is in for the month. Joins the bills by category in
  `monthlyPL`.
- **The books audited as an accountant would** (`money-ledger.md` §8, `logic-audit.md`). Four fixes:
  standing costs count on the cash account on `standing_costs.paid_day` (migration `0074`, regenerated)
  and never by the day; category kind `balance_sheet` (loan principal, owner draws, equipment
  bought, income tax; `EXPENSE_KINDS`, seeds) shows below "Net cash from operations" on the cash
  statement with a **Cash change** after it and never on accrual; a rebate statement entered on
  Spending replaces the ladder estimate; a bill under "Drug purchases" is left out on both bases
  and named. `MonthlyPL` and `PeriodPL` gain `otherCashOut`, `otherCashOutCents`, `cashChangeCents`;
  `standingLines` takes the basis. Your `period-account.ts` types were not touched; its test
  fixture gained the three fields. The owner has asked for a logic audit of every page; findings
  go in `logic-audit.md` page by page as I reach them.
- **The bank's statement reads in** (`src/lib/bank-statement.ts`, pure and tested; `money/bank.ts`
  action; `bank_lines` table in migration `0078`). The CSV export's date, description and amount
  columns are found by name (one amount column, or debit and credit); a deposit naming a PBM on the
  claims, the facilitator, a wholesaler or card takings is banked as a receipt of that kind; a
  payment exactly matching one open bill or invoice by amount and name marks it paid on that day;
  everything else is listed on the books page as not placed; every line is remembered by date,
  amount and description so a statement read twice banks nothing twice. Verified end to end on a
  fresh database. The intake review card seeds the expense categories if Spending was never opened.
- **The intake now takes anything with money on it** (`src/lib/business-docs.ts`; `intake/actions.ts`
  `readIntoIntake` and `applyBusiness`; `intake/[id]/business-review.tsx`; "Sort it" on the Inbox,
  `sortInboxItem`). A dropped or photographed file goes: recognised report → loads itself; an X12
  835 → `importRemittance` (source `plan`, revenue nought — a plan's own remit settles the claim —
  and the total banked as a receipt) with the file kept as `remittance`; else Claude reads it as a
  wholesaler invoice / bill / remittance advice / rebate statement / statement / credit memo / bank
  statement, and the review card files it: `fileInvoice` + lines; `saveExpense` with a new vendor
  added on the card and a duplicate refused; payments per claim + the bank; a negative "Wholesaler
  rebates" bill that replaces the estimate. Compliance documents still go to your `classifyDocument`.
  Document categories gained `bill`, `remittance`, `bank_statement` (labels added). `ai.ts` now
  exports `client`, `logUsage`, `MOCK` for the new reader; nothing else in it changed. Verified on a
  scratch database with `AI_MOCK=1`: a bill lands on Spending with its vendor added; an 835 posts one
  payment and one receipt.
- **The engine map and the audit** (`engine.md`, `logic-audit.md`): every feed the business runs
  on, what it ties to, and its state; the three balances (claims, books, remits to claims) and
  which are working. Found on the way and fixed: retail on the sales summary was read from the
  Total column (after sales tax; $380.87 on the real August was the state's money), now the
  Subtotal with `sales_months.retail_tax_cents` held (migration `0074`, regenerated again);
  the Kansas-floor row on Money found summed under-fee fills per claim row (a coordinated fill's
  secondary leg counted as unpaid) and now carries the floor page's filable figure; the buy
  list's lead time was never more than a day; any catalogue flag read as rebated and the generic
  importer stored the file's own Y/N, which nothing recognised (`contractFlagOf`); the compliance
  ratio's denominator included OTC lines; the purchasing ledger left facilitator refunds out of a
  fill's revenue. **Nothing can enter a cash receipt** (`addCashReceipt` has no screen), so the
  cash account's revenue is always missing; that and commercial 835s are the next two builds.
- **Pages that were sides of one thing are now families** (`src/lib/families.ts`, `PageHeader tabs`,
  `itemFor` in `nav.ts`; `design-audit.md` §8 has the verdict on every page and why). The sidebar
  lists a family once and each page in it carries a row of tabs: the books / statement / over time;
  today's order / the shelf / minimums; the floor / plans / appeals; payers / contracts / sort /
  routing; training / file / material; inspection / walk; inbox / intake. The Remits group (one
  page) is folded into Claims with "Who pays best"; `/invoices` (two links) redirects to the
  supplier invoices; "Find anything" leaves the menu (the search box is the way in). **Pages of
  yours touched, header only** (a `tabs=` line and the import; a `back=` link that pointed inside
  the same family removed): `money/report`, `purchasing`, `purchasing/shelf`, `claims/floor`,
  `plans`, `payers/contracts`, `compliance/training`, `compliance/training/material`, `inspection`,
  `inspection/walk`, `inbox`, `intake`; `records` links the two invoice pages directly. Nothing
  below any header changed. The `Bars` chart (`bars.tsx`) was drawn in a 100-unit box stretched to
  the card, which smeared every printed figure ten times wide; it now keeps its shape.
- **The whole site is restyled from the system, not the pages:** `globals.css` (a tighter type scale,
  one control height, KPI tiles, denser tables), a dark sidebar with icons (`nav.tsx`, `icons.tsx`),
  a top bar with the breadcrumb (`crumbs.tsx`, `layout.tsx`), and `ui.tsx`/`kit.tsx`. Pages that use
  the shared classes changed without being edited. Pages of yours edited for the above: the invoices
  page (Paid column; its "Check these are all really invoices" form was nested inside the table's
  form and did not hydrate, now a `formAction` button), the supplier terms page, Spending,
  `submit-button.tsx` (a `formAction` prop).

- **The two live refusals can be explained without paying again.** "Ask the API why" on
  `/payers/sort` (`recoverFailures` in `contract-extract.ts`) reads the batch ids from the
  `contracts.extract.queued` audit lines, fetches each batch's results (held 29 days) and writes the
  API's own reason on each refused document; a read that finished but was never collected is kept.
  Once this merges, the owner presses it first, then "Read … now" on the 3-page document.
- **A design pass over pages of yours, class strings only.** Every hand-typed primary button is
  `btn btn-primary`; the four deletes (`/licenses`, `/staff/[id]`, `/cqi/incidents`, the stored key
  on `/settings/connections`) are `btn btn-sm btn-danger`; five tables gained an `overflow-x-auto`
  wrapper; `/purchasing` opens with five figures and ends with the Ordering `Hub`. `design-audit.md`
  §7.3 says what is done and what is left. A Remits landing needs a file under `remits/`, which the
  cloud session's tooling cannot write: `Hub` with explicit `items` does it (see `records/page.tsx`).

### For the pharmacy session (from the cloud session, PR #3)

Done by the pharmacy session at `3c2c18c`: the statement selects the band (the daily figure is
shown as a position, with the gap to the scrubbed figure carried live); invoices de-duplicate on
the supplier's number and date; the database-backed tests use a migrated scratch file; gitleaks
has `pull-requests: read`. Migrations `0062` and `0063` are theirs; the recommendation log and the plan PCN are `0069` (their `0064`–`0068` came first), merged in PR #3; the search column on `contract_text` is `0070`, on the follow-up pull request. Both sessions built
the shelf and order-minimum pieces on the same night; the cloud session's `lean-stock.ts` and
`order-basket.ts` were withdrawn for the pharmacy session's `usage.ts`, `on-hand.ts`,
`order-plan.ts` and `lean-shelf.ts`, which are wired and have a real on-hand reader.

- [ ] **Hold every new figure to `docs/reference/data-dictionary.md`** before it is used: unit,
      source, "use for", "never for". §8 names the ten double-application traps; a module that
      trips one is wrong even when its arithmetic is right.

Done by the cloud session at the commit after `96b5ef4` (pages touched: `money/page.tsx`, the
Today page's data load and one new section, `nav.tsx`, `nav.ts`, `money-found.ts`,
`recommendation-store.ts`): the sidebar drops the four gated Money links while the flag is off;
`switch-supplier` and `dispensed-at-a-loss` are scaled to a month by the span of claims and wait
under "worth watching" below a week; `recommendations()` rows (`switch-ndc`, the unpriceable
plans, the unstocked NDCs) are in `moneyFound()`; the log is written on every build of the list,
each row shows its age, and "Done it" / "Not doing this" buttons write the owner's word; the
scorecard sits under the list; Today shows the three rows worth the most under the scoreboard.
Verified on a scratch database with the real feeds: typecheck, 1,468 tests, `next build`, and a
browser check of the sidebar with the flag off and on.

- [ ] **Two inputs `recommendations()` still lacks:** `tier` (the band-risk row: needs the month's
      position on the statement's scrub, the ladder, the OneStop base from `earningSoFar`, and
      `tierEffect` with no lines) and `plans` (from `payBasisByPlan` over the claims with NADAC).
      Both are a loader each in `money-found.ts`; the rows and their tests exist.
- [ ] **Write `pay-basis.ts` results to a table nightly** (`plan_pay_basis`, to add) so the NDC
      choice reads a table and the trend is kept (`profit-engine.md` §3, §6.2).
- [ ] **The month plan, with every variable at once.** `monthPlan()` in `month-plan.ts` takes the
      products (NDC offers per supplier, NADAC, pack, plan mix, demand from `usageFromFills`,
      on hand), the three ladders, the month's position on the scrubbed basis, and the suppliers
      with minimums; it returns the band to aim at, every line's NDC and supplier, the moves, and
      the total, with the next best band beside it. This supersedes wiring the band strategy on
      its own. Demand and shelf come from your `usage.ts` and `on-hand.ts`; minimums from the supplier
      fields you added at `0e14cb4`. The recommendation log is now migration `0069`, with the plan PCN column.
- [ ] **The McKesson question, monthly.** `bandStrategy()` in `band-strategy.ts` needs: the
      position (drill-down, restated to the statement's scrub), the ladder, the month's OneStop
      base, and two levers from the catalogues: unscrubbed brand spend that could move and its
      premium at the secondary (plus the brand factor), generic spend that could come to McKesson
      and its effective premium. Show `strategy.says` on the money page and on the supplier card.
- [ ] **Back-calculate each plan's formula.** `fitPlan()` in `reimbursement-fit.ts` over the
      claims with NADAC in force and AWP from `invoice_lines`; show the sentence per plan on
      `/payers/[pbm]` and feed the residuals to the appeals list. Needs AWP beyond McKesson lines:
      see the owner's items.
- [ ] **Put the buy list on the purchasing page.** `underNadac(ledger.rows, groupOf)`,
      `switchNdc(u)`, `notYetBought(u)` from `src/lib/under-nadac.ts`; `groupOf` from
      `product-groups.ts` over the NADAC rows held. Each `ProductPick.says` is a sentence to print.
- [ ] **Add the buying logic's rows to the money list.** `recommendations()` in
      `src/lib/recommendations.ts` returns `MoneyRow[]`, `blocked[]` and `watch[]` from the buy
      list, the band position and the plan bases; spread its rows into `moneyFound()`.
- [ ] **Scale the money list's recurring rows to a month.** `switch-supplier` and
      `dispensed-at-a-loss` sum over every claim held and are labelled "a month"; after ninety
      days of feed they will say three times the truth. `perMonthCents(amount, spanDays(from, to))`
      in `recommendations.ts` does it; the claims' first and last `dateFilled` give the span.
- [ ] **Extend `ReadPurchaseDrillDown`** to the fields in `drill-down.ts` `FIELDS_WANTED` and run
      `checkMonth` after the read; the prompt's "Purchase Summary by Month" is titled "Purchase
      Drill by Month" on the report.
- [ ] **Keep the printed gross profit apart from the arithmetic.** The report's GrossProfit
      includes PioneerRx's *estimated* rebate and DIR ("Uses invoice cost … Includes columns for
      estimated rebates and estimated dir fees"). On the real 5 Sept file four rows differ from
      Amount + Total − Acq. Inv. Cost by 18¢ to $1.02, all on plan 003858. Store that difference
      per row as `reportEstimateCents` so it is visible, and never use the printed figure as margin.
- [ ] **Keep catalogue price history** (`data-audit.md` §3.1): append each import to a
      `supplier_price_history` table; `supplier_items` stays "current".
- [ ] **One row per period for the rebate statement and the drill-down position**
      (`data-audit.md` §3.2, §3.3), instead of settings JSON and `rebate_statement_json`.

**From the daily audit of 6 September** (base commits `75fc165` and `c5012fe` read; typecheck
clean; 1,468 tests; the real 5 Sept report reads as before, 135 rows, no AR rows in that day).

- [ ] **`receivableCents` counts plan money as uncollected.** `fills.ts` sets
      `receivableCents = revenueCents` on any fill with an AR leg, and `revenueCents` includes the
      other legs' remits. On the shape in your own commit message (Rx 333932-0: an AR leg with
      cost and no revenue, a paid leg on another BIN with $491.67) the fill reports $491.67 owed
      on account when it is the plan's remit, already tracked by the remittance reconciliation.
      That is one dollar in two "not money yet" buckets (`data-dictionary.md` §8). Fix: sum the
      patient total of the AR rows only (`rows.filter(onAccount).reduce(patientTotalCents)`);
      `unbilledCostCents` is right as it is. The test "one leg on account puts the whole fill on
      account" should then expect a receivable of $600.00, not $608.00.
- [ ] **Supplies: an empty shelf with an order pending reads "ok".** `supplies.ts` `position()`
      folds `onOrder` into `available` before deciding the state, so `projected <= 0` with a
      delivery due in five days is "ok" for five days. Decide "out" on `projected`, keep
      `daysRemaining` on `available`, and say "out; N on order, due about <date>". Also
      `RATE_WINDOW_DAYS` is 180 and its comment says ninety.
- [ ] **Price moves, ready to wire once `supplier_price_history` exists.** `priceAlerts()` in
      `src/lib/price-moves.ts` takes the history rows, the NADAC weeks, usage per NDC (units a
      day from `velocity()`, the floor share from `pay-basis.ts`) and the alternatives per
      product, and returns money-list rows: `price-up:<ndc>` (the cheapest source rose; cost on
      this pharmacy's units a month; the cheaper NDC to buy instead) and `under-cost:<ndc>`
      (NADAC now under cost where it was not; on the units paid at NADAC; switch, stop or
      appeal). Transitions only, so the standing buy list is not counted twice; `overlapsWith`
      set. This is `profit-engine.md` §6.3 done on the pure side.

**The contracts** (`docs/reference/contract-reading.md` is the specification the owner asked for:
what to get from every document, why, and where it goes). The reader (`contract-extract.ts`,
Batch API, cited schema) and the index (`contract-search.ts`) already existed; what was missing
was everything after the draft. Pure and tested now:

- [ ] **`rate-formula.ts`**: a contract's sentence ("Lesser of (MAC or AWP-25%) + $1.00") into
      legs, lesser-of and fee; `expectedCents()` prices a claim on the benchmarks held, "at most"
      when a MAC leg is not held, null with the reason when nothing is. Wire into the claims page
      once `payer_links` carry a contract: expected beside paid, per claim.
- [ ] **`contract-apply.ts`**: `proposeFromContract(draft, plans, existing)` → the checklist a
      person accepts: rate rows (new/same/changed against `network_rates`, with the quote),
      the appeal terms, contacts by purpose, the payment path, and the plans the document
      governs (BIN+PCN before BIN; group alone never; contested BINs named). `groupByCounterparty`
      is the third-parties page. **Built by the cloud session:** `/payers/contracts` (look in the
      folder: every PDF adopted as a document, named from the manifest's `pbm_name` column or by
      hand; read with the cost shown; collect; read again) and `/payers/contracts/[id]` (the draft
      as a checklist; accept writes `network_rates`, `mac_appeal_terms`, `pbm_contacts`,
      `payment_routing`, `payer_links`, then `applyLinksToClaims`). `contract-docs.ts` is the
      server side. Driven end to end with `AI_MOCK=1` on a scratch database. Linked from Payers.
      Since then: "Apply everything certain" (`applyAllReads`) writes every certain row from every
      read document in one press and names unnamed documents canonically; counterparties resolve
      through `pbmResolver()`; the run respects the API's page, size and batch limits, checks the
      ceiling first, records its tokens for the spend page, and names a truncated answer; "Read
      this one" proves the path on one document. The pharmacy's own payer list
      (`data/reference/payer_listing.csv`, `payer-listing.ts`) names 80 BINs and attributes the
      claims held.
- [ ] **`appeal-packet.ts`**: `buildPacket()` assembles a MAC appeal from the claim, the contract
      figure, the invoice line, the PBM's terms and the deadline, or refuses with every reason.
      **Page to build:** an appeals queue under `/claims`: claims paid under the contract figure
      or under acquisition cost → packet → send by the PBM's channel (email through the mailbox
      where accepted; otherwise the fields and attachments prepared for the portal) → logged
      against the claim, scored by the next remittance.
- [ ] **`contract-terms.ts` gained** `contacts[]` (by purpose), `remittance` (who pays, method,
      cycle, 835 offered, how enrollment is changed, whom to ask), `macAppealRequiredFields`,
      `macAppealInvoiceRequired`, `macAppealSubmissionTarget`; the prompt asks for them (rule 12).
      Old drafts still parse (`parseTerms` defaults the additions). Re-run the read on the
      documents that matter most to pick them up.
- [ ] **835 to the site** (spec §6): a mailbox address or SFTP folder the site owns as the ERA
      delivery point; an enrollment checklist page per PBM (enrolled, delivery confirmed, first
      835 received) reading `payment_routing` and `pbm_contacts`; the `x12-835.ts` parser and the
      remittance reconciliation already exist for the facilitator files.

**From the claims-field review of 6 September** (the real 5 Sept report: 123 paid/adjusted rows,
19 BINs, 22 PCNs, 35 groups, 26 network reimbursement ids; `contract-reading.md` §1 and §4).

- [x] **A plan is BIN, PCN and group, not BIN and group** (cloud session, migration 0069 shared with the recommendation log,
      `plan_groups.pcn`). `planKey(bin, pcn, group)` and `planLookup()` live in `plan-key.ts`
      (pure, shared with the floor review). An old row with a blank PCN stands as the fallback for
      any PCN on that BIN and group until a row for the PCN is decided; the sync notes on the new
      row which classification it inherited, so somebody confirms it. The payer chain, the payer
      tree, the subsidy test, the NADAC standing and the pay-basis reading are all keyed the same
      way; the classify and link forms on Payers carry the PCN. Found on the way: `allFills()` was
      dropping the group number from the fill's payers, so the NADAC standing never found a plan.
- [ ] **The network reimbursement id (NCPDP 545-2F, the report's "Ntw Reim. Id") is the contract's
      own name for the claim and is used nowhere but as a display list.** Filled on 63% of rows;
      10 of 25 BIN+PCN pairs see more than one value (Preferred against Standard, or a plan
      sponsor's own network). It is the axis the rate exhibits are written on (§1), so: carry it
      into `payer_links` matching as the `contractId` it already stands in for
      (`applyLinksToClaims` passes it), let `proposeFromContract` match a document's network
      names against the ids seen on its BINs, and split "who pays best" by it under each PBM.
- [ ] **Columns the daily report does not carry** and no reader fills: `plan_id`, `plan_type`,
      `pharmacy_service_type`, `basis_of_reimbursement` (522-FM), `basis_of_cost_determination`
      (423-DN), `awp_cents`, `daw`, `days_supply`, `quantity_unit`. Every one is a PioneerRx
      column the owner can add to the scheduled report; 522-FM settles the pay basis outright and
      AWP settles the contract formula. Until then they are null, and nothing should read them as
      zero. `other_coverage_code` is on the report and blank on every row.

**From the review of `ea77544` (the drill down read from the document, 6 September evening).**
The reader is right to let the document decide, and the two identities it checks are the ones in
`drill-down.ts`. One thing to add before the daily figure is trusted to pick the band on its own:

- [ ] **Prove the four exclusions are McKesson's whole scrub, on the same month.** `FULL_SCRUB`
      (flu, dropship, specialty, GLP1) is asserted, not yet shown: the only proof is a daily
      reading for month M agreeing with the statement for month M. `driftPercent` today compares
      the statement (last period) with the daily figure (this month), which is two months and not
      a check. Keep the last daily reading per month (`purchase_positions`, already on the list)
      and, when the statement for M lands, compare it to the last scrubbed daily reading for M:
      within rounding, the list is proved and the daily figure may keep selecting the band; wider,
      the list is incomplete, the daily figure goes back to a position, and the gap is shown with
      the two months named. Until the first statement arrives on a scrubbed month, say on the
      supplier card that the band is selected on a figure not yet reconciled to a statement.

**From the design audit** (`docs/reference/design-audit.md`; the page inventory is §7). Ordered
by what changes the owner's morning most. Each is small on its own; none needs a migration.

- [ ] **The sidebar bug above**, first: filter `NAV` items on the flag in `nav.tsx`, or drop
      the flag (design-audit §6).
- [ ] **Row actions everywhere** (§7.1). Done by the cloud session: `/expenses` bills (Edit
      reopens the form with the bill in it; Void keeps the row marked void and out of every month
      and total; `expense.edit` and `expense.void` audited); `/inventory/discrepancies` ("correct it"
      reopens the entry, `discrepancy.edit` audited; a wrong entry is closed with the reason, never
      deleted). `/plans` already had classify per row. `/suppliers` has Retire and `/deliveries` has Clear
      on a day, which the inventory missed; `/staff/rotations` rows link to the student's Edit. Still
      to do: `/payers/[pbm]` contacts, rates and documents; voiding an issued driver invoice on
      `/deliveries`; `/settings/backups` archives (under a path the cloud session cannot read).
      `/agreements` is the model: Edit and Delete on the row, a confirmation that names what
      goes with it. Records the law keeps (invoices, C2 records) retire with a reason.
- [ ] **One feedback helper and one key** (§7.2): `?ok=` everywhere, and a success notice on
      the nine error-only forms (`/cqi/*/new`, `/cqi/import*`, `/intake/[id]`, `/reports`,
      `/settings/updates`, `/money/monthly`, `/staff/new-hire/pack`).
- [ ] **One button system** (§7.3): replace the forty-odd hand-rolled `bg-ink` and bare-link
      buttons with `btn`, `btn-primary`, `btn-danger`; give `ConfirmButton` a default class.
      `/nadac`, `/remits/mtf`, `/plans`, `/payers` have no `btn` at all.
- [ ] **One page shape** (§3.1, §3.2): `PageHeader` on the six real screens without one; `Card`
      in place of the raw `<h2>` on `/settings`, `/nadac`, `/remits/mtf`, `/purchasing`, `/cqi`;
      explanatory prose behind a "How this works" disclosure, one line left in place. Delete the
      unused `.section*` classes or use them.
- [x] **Tables get tools** (§3.4): `src/components/data-table.tsx` (sort by any column, a
      filter box, "show 50 more", money right-aligned by the column, `th scope`, `aria-sort`),
      used on `/payers/performance` (per drug, the payer ranking) and `/purchasing` (the ledger,
      the comparison). Still to move: `/claims`, `/inventory/invoices`, and the fourteen
      unwrapped tables.
- [ ] **Forms out of the flow** (§3.5): "Add a supplier", "Load a price file", "Add an invoice
      by hand", "Create login" become a header button opening a drawer or its own page.
- [ ] **Today leads with money** (§3.3): scoreboard, then the top three rows of `moneyFound()`
      with amount and action, then "Needs you", then compliance folded into one card with a count.
- [ ] **Settings as tabs** (§4): Pharmacy, Identifiers, Logo, Claude, Logins, Network, Backups;
      `/nadac` reduced to one status line, one Fetch button, coverage figures and the weeks table,
      the rest behind "Advanced".
- [ ] **Colour semantics and identity** (§3.8, §3.10): green is the accent and "ok", amber
      "worth checking", red "money the wrong way" or "late"; add an `info` tone; a mark and the
      pharmacy's logo in the sidebar; `font-variant-numeric: tabular-nums` on `.num`.
- [ ] **Link the orphans** (§7.4): `/intake` has no inbound link; `/nadac`, `/plans`,
      `/payers`, `/claims/floor`, `/purchasing/shelf`, `/cqi/import`, `/compliance/register`,
      `/manual/decisions` need a place in a group or a link from their parent page.
- [ ] **Accessibility and width** (§6): helper grey `#7c8683` on white fails AA at 12 px; focus
      rings; `th scope`; a collapsible sidebar under 1,100 px.


### For the cloud session (from the pharmacy session)

- [x] **Migration 0077 exists twice, and the merge would lose yours silently.** Done at the merge: mine is `0078_standing_costs_terms_pages_tax_bank_items`, stamped `1788756799966`, after yours; your journal check passes on a fresh database. Both branches
  generated a `0077`: mine is `0077_neat_ma_gnuci` (routing columns on `network_rates`), yours is
  `0077_standing_costs_terms_pages_tax_bank` (`bank_lines`, `standing_costs`, four columns). This is
  not a naming clash — drizzle decides what to apply from the `when` stamp in
  `drizzle/meta/_journal.json` and nothing else, applying only what is stamped later than the last
  one it ran. Yours is stamped `1788752482954`; mine is `1788755643749`, an hour later. The pharmacy
  computer pulls `feature/compliance` (`update.ps1` line 12), so **mine is already applied there**.
  When your branch merges, yours arrives with the earlier stamp, drizzle treats it as already run,
  and `bank_lines` and `standing_costs` are never created — no error at migrate time, and a 500 the
  first time `/money` is opened. Renaming the file does not fix it; the stamp decides.

  **The fix, at the merge:** renumber *yours* to `0078` **and raise its `when` above `1788755643749`**.
  Never renumber mine — it is the one already applied on his machine, and changing it re-runs an
  `ALTER TABLE ADD COLUMN` against columns that exist.

  `scripts/migrate.ts` now refuses to run on either shape of this — a duplicated `idx`, or a stamp
  that is not after the one before it — with the message saying which file to change and to what.
  So the merge will stop rather than lose a table, but it still has to be resolved by hand.

- [x] **`remitCheck` raises a false short-pay on every coordinated fill.** Fixed as you describe: `RemitFill.payers` carries the legs, each plan payment goes to the leg whose payer it names (one naming nobody to the first unpaid leg, primary first), a leg with no payment is awaiting, and the short line names its own leg. `checked` and `awaiting` now count legs. `remit-check.ts` compares
  a fill's `remitCents` — which `groupIntoFills` sums across *every* payer leg — against the sum of
  its `laterPayments` where `source === "plan"`. On a fill coordinated across two plans, the
  primary's 835 arriving first gives `paidCents` = the primary alone against `adjudicatedCents` =
  primary + secondary, and the fill is reported short by the whole of the secondary's payment. There
  are 29 such fills in the data I have here (73 claim pairs on the full file), so this is roughly
  5% of fills raising an appeal for money that was never short. An appeal filed on it is withdrawn,
  which is the failure the citation rules elsewhere exist to prevent.

  The fill already carries what is needed: `Fill.payers` is `FillPayer[]`, each with its own `name`
  and `remitCents`. Compare per leg — match each plan payment to the leg whose payer it names, and a
  leg with no payment against it is `awaiting`, not `short`. That also fixes `payer: plan[0].payer`
  on the short line, which currently names one payer arbitrarily where there are two.

- [x] **Contracts page: `triage` and `triageWhy` on each row, and the sort in its header.** Done,
  and further than asked. Ruled-out documents are now out of the table, out of `withFile`/`allPages`,
  and out of `estimateAll` — they were being counted and priced into "Read everything again" even
  though `queueExtraction` would never have sent them, so the price on that button was wrong. They
  sit in a card of their own with what the sort made of each and a button that puts one back. The
  contracts page names the sort as step 1 and warns when documents have not been through it; the
  sort page shows what the read now covers and what it would cost, so the figure the sort exists to
  move is visible while it moves.

### For the owner, on the pharmacy computer

- [ ] Schedule the PioneerRx transaction report to cover **yesterday**.
- [ ] NADAC page: "Read the listing now", then "Fetch this week" on a gap. Neither session can
      reach data.medicaid.gov.
- [ ] Suppliers page: set the catalogue name on McKesson, IPD, IPC, ParMed.
- [ ] Ask PioneerRx for an on-hand/expiry report, and add to the daily transaction report:
      Basis of Reimbursement (522-FM), Basis of Cost Determination (423-DN), Dispensed AWP, DAW,
      Days Supply, Plan ID. The report already carries the Network Reimbursement ID (545-2F);
      Other Coverage Code (308-C8) is on it and blank.
- [ ] **Schedule the daily on-hand export** out of PioneerRx to the mailbox; the reader exists
      (`on-hand.ts`, columns matched by meaning). Include lot and expiry and on-order if it can.
- [ ] **Each supplier's order minimum, free-freight threshold, freight and lead time** on its
      terms page, and mark McKesson as primary. Blank means not known, which the buy list treats
      differently from zero.
- [ ] **Which products McKesson scrubs** from the compliance ratio, from the OneStop agreement or
      the rep: GLP-1s are known; the full list makes the brand lever exact.
- [ ] **AWP, free:** schedule a PioneerRx item report (NDC, AWP, WAC, package size) emailed
      weekly, and add "Dispensed AWP" to the daily transaction report. The weekly catalogue export
      carries no AWP; only McKesson's invoices print it.

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
unknown), `under-nadac.ts` (the buy list: every NDC ranked by its gap under NADAC after the
rebate, the pick per product and the gain over what is dispensed today), `ndc-choice.ts` (which NDC of a product pays the most on this pharmacy's plan mix,
or "cannot say" with the reason), `ratio-effect.ts` (what an order does to the ratio and the
band, in money), `price-moves.ts` (what changed this week: a rise in what the pharmacy
would pay, or NADAC falling under cost, each on this pharmacy's own units). None of them touches the database or a page. Wiring them to the product ledger
and an order screen is the next step, and is the pharmacy session's call on where.

### Data audit
`docs/reference/data-audit.md`: how every feed lands and ties, what is well organised, ten fixes
in order of consequence (catalogue price history is discarded weekly; the drill-down is the one
unchecked model read that selects money; the rebate settlement is stored three ways; supplier
and payer are each keyed two ways; cash sales are dropped; an invoice de-duplicates on document
id only), and twelve further uses of the data ranked by value against readiness. `product-groups.ts`
now delegates to `product-key.ts`, which it had duplicated.

### Files this branch touched
`src/db/schema.ts`, `drizzle/0048_*`, `drizzle/0049_*`, `src/lib/{ndc,ndc-held,supplier-terms,supplier-terms-store,invoice-lines,nadac-sources,product-groups,pay-basis,under-nadac,ndc-choice,ratio-effect,drill-down,recommendations,recommendation-log,recommendation-store,reimbursement-fit,band-strategy,month-plan,price-moves,rate-formula,contract-apply,appeal-packet}.ts` (new), `drizzle/0069_*`,
`src/lib/{claims,rx-transactions,suppliers,suppliers-registry,pioneer-catalog,invoices,nadac-fetch,settings}.ts`,
`src/app/(app)/suppliers/page.tsx`, `src/app/(app)/suppliers/[id]/terms/page.tsx` (new),
`src/app/(app)/inventory/invoices/page.tsx`, `src/app/(app)/nadac/page.tsx`, `src/app/(app)/claims/page.tsx`,
`tests/{ndc,supplier-terms,invoice-lines,nadac-datasets,product-groups,pay-basis,under-nadac,ndc-choice,ratio-effect,drill-down,recommendations,recommendation-log,invariants,reimbursement-fit,band-strategy,month-plan}.test.ts` (new), `tests/{claims,suppliers-registry,rx-transactions}.test.ts`,
`CLAUDE.md` (new), `docs/HANDOFF.md`, `docs/reference/nadac-api.md`, `docs/reference/buying-logic.md`, `docs/reference/data-audit.md`, `docs/reference/profit-engine.md`, `docs/reference/data-dictionary.md` (new), `fixtures/README.md`, `fixtures/rx-transactions.txt` (new).

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
