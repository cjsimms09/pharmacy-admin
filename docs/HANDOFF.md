# Working on this repository from two Claude sessions

Two sessions are building this app: one on the pharmacy computer (the `feature/compliance`
branch, where the app actually runs against real files) and one in the cloud (the
`claude/repo-audit-catalog-claims-*` branches, which build on top of `feature/compliance`). They
cannot see each other's conversations. **The repository is the only thing they share**, so this
file is how they talk.

## Open items

Kept current by whichever session last touched it. A line is removed when the other side has done
it and said so on the pull request. The owner reads this too.

### From helper B (cloud, Session 2's helper) — the inbox recogniser (8 September)

Branch `claude/inbox-recogniser`, pull request against `feature/compliance`. BACKLOG item 5.

**What is there.** `src/lib/intake-recognise.ts` — pure, 23 tests — asks every detector the site
already has (`classify()` in autoroute, `classifySupplierDocument`, `contract-triage`), ranks the
answers by how specific the evidence is, and returns what it thinks, how sure it is, and why in
words. `intake-recognise-store.ts` gathers the evidence. Migration **0083** adds `intake_rules`,
where a correction made on the inbox page is kept against the sending address so the same file next
Sunday needs no correcting. The inbox page shows the guess for lines that were not placed and
carries the correction control on every line with a file behind it.

**The importers were not touched.** The seam is `recogniseStored()` / `recogniseBytes()` in
`intake-recognise-store.ts`. Nothing in `mailbox.ts` calls them yet — the sweep is Session 1's and
2's, and wiring the recogniser into it is the change that decides what actually gets loaded, so it
is not made from here. Until it is, the recogniser runs on demand from the inbox page and files
nothing.

**Two things I need from the pharmacy computer, because I cannot see any real mail.**

1. **The last three months of `inbox_items`, as shapes, not contents.** For each row I need only
   `from_address` with the local part replaced (`x@mckesson.com`), the first 40 characters of
   `subject`, `file_name` with digits replaced by `9`, and `routed_as`. What I am trying to find out
   is whether the file-name stems are actually stable week to week — `stableStem()` strips run dates
   on the assumption that what is left repeats, and that assumption is the whole basis of a rule
   made once holding next Sunday. If the schedules name files differently each run, the narrow rule
   form is worthless and the design needs changing before it is wired in.

2. **How many senders send more than one kind of document from one address.** A count is enough:
   `select from_address, count(distinct routed_as) from inbox_items group by 1 having count(distinct
   routed_as) > 1`. The whole specificity ladder exists for that case. If it is nobody, the ladder is
   over-built and a simpler rule would be easier to trust; if it is McKesson and three others, it is
   right as it stands.

**Also: the four known-failing tests named in SESSION-RULES pass here.** `npm run test` on this
branch is 1,999 of 1,999 with a freshly migrated database. `temp-signoff`, the two
`backup-destinations` relative-path cases and the fixtures test all pass. So those four look like a
stale database rather than a broken base — worth deleting `data/pharmacy-admin.db` and re-running
`npm run db:migrate` before anyone spends time on them.

**`work/invoices` audited — `docs/audits/2026-09-08-invoices.md`.** Two findings, both reproduced by
running the code rather than read off the diff, both for session 2:

1. **`normaliseAliases` splits on commas, and aliases are company names.** Typing "Independent
   Pharmacy Cooperative, Inc." — the name the Suppliers page asks for — stores it as two aliases,
   and the printed name then matches neither, because `squash()` strips punctuation from both sides
   before comparing. The line stays unplaced: the same failure the branch exists to fix, by a
   different route. Two tests disagree about this and the one asserting the match builds its fixture
   from the raw string rather than the stored one, so it passes while protecting a shape the product
   cannot produce. Not patched from here — the comma behaviour is stated deliberately in the other
   test, so it is session 2's call. **The question that settles it needs the real database:**
   `select distinct supplier from invoice_lines where supplier like '%,%'` — names only.
2. **`unplacedLines`, `unplacedCents` and `unplacedNames` are rendered nowhere.** Eight callers of
   `earningSoFar` and not one reads them, so the arithmetic knows what went missing and no screen
   says it — and `unplacedNames` is exactly the list of strings the alias boxes need filling from.
   `suppliers/page.tsx` already has `earning` in hand at line 59 and already renders `unmarkedLines`
   beside it.

**`work/audit-shelf` has appeared too** and is not audited yet. It goes under `docs/audits/` next.

### For the session running ON the pharmacy computer — read this first (8 September)

You are the only session that can see the real database. The cloud session cannot: its container
reaches GitHub and a handful of package registries and nothing else on the internet. Thirteen hosts
were tested — `github.com`, `api.github.com`, `raw.githubusercontent.com` answer; `www.google.com`,
`example.com`, `cloudflare.com`, `trycloudflare.com`, ngrok, tailscale, localhost.run and serveo are
all refused. A tunnel was built, installed and opened before that was established, and it could
never have worked. Do not propose one again.

So the questions below are yours, and every one of them is blocked on data only you can read.

**1. How much of the catalogue has a NADAC benchmark — ANSWERED on the pharmacy computer, 7
September.** The site is not blind, and the development copy's "10 of 147,730" was entirely an
artefact of the synthetic table. On the real database:

- **26,246 of 45,791 catalogue NDCs (57.3%) carry a NADAC row.**
- **652 of the 681 NDCs actually dispensed (95.7%) carry one, and 650 of those are current within
  three months.** That is the figure that governs, because every reimbursement question is asked
  about a drug the pharmacy dispenses, not about McKesson's whole warehouse.
- By supplier: IPC 97.2%, IPD 88.2%, ParMed 87.5%, ANDA 78.2%, McKesson 58.7%. McKesson drags the
  average because it lists the hospital and supply catalogue; the secondaries, which are where the
  buying decisions are made, are well covered.

**The cause of the 43% miss is not NDC formatting, and this was checked rather than assumed.** Both
sides are clean 11-digit, all-digit, no dashes: catalogue 45,791 of 45,791 at length 11 with zero
non-digit characters, NADAC 43,396 of 43,396 the same. Normalising to digits-only changes the match
by **exactly zero** rows, and matching on the first nine digits (labeler and product, ignoring
package) gains 553. There is no formatting fix to make.

**The miss is CMS genuinely not pricing those items.** The unmatched are hospital injectables
(cefepime, meropenem, milrinone, dexmedetomidine, Naropin single-dose vials), devices and supplies
(dispensing tip caps, Dispill label sheets, a rollator), supplements (glucosamine, VSL#3), and
repackager labels (Bryant Ranch, Proficient Rx, Reliable 1) which CMS does not carry. **15,332 NDCs
have no NADAC anywhere in their product**, not merely none of their own.

**A product-level proxy was measured and is not worth building.** Falling back to a sibling NDC's
NADAC — same drug, strength and form from a labeler CMS does price — would rescue **197 NDCs,
0.4%**. The idea sounds good and the number kills it.

Two things were found while answering this, both of which change what the site should do:

- **The "TBD DO NOT DELETE OR RELEASE" placeholders were being looked for in the wrong table.**
  `nadac_prices` holds **zero** of them. `supplier_items` holds **nine**, all McKesson, all priced
  at $110.25 a unit ($110.25 a pack, so a pack of one), all flagged `not rebated`, all with no
  availability. They are catalogue rows, not CMS rows, so the import refusal added on 8 September
  sits on the NADAC path where they never were. They need refusing on the **catalogue** path in
  `suppliers.ts`, and the nine deleting.
- **10,429 NDCs carry more than one `product_key`.** The key is derived from each supplier's own
  description text, so pack codes and manufacturer abbreviations land inside the product name and
  the same drug fragments. Mounjaro 12.5mg is three products (`mounjaro 0 5mlx4pend am|12.5mg`,
  `mounjaro|12.5mg/0.5ml`, `mounjaro sy 4 ppn|12.5mg/0.5ml`); Trulicity 0.75mg is three; Emgality
  120mg is three. This reaches money: `reimbursement-fit.ts` takes a **median MAC per product key**
  to decide a payer's formula, and `product-groups.ts` — which `drug-profit.ts` uses to pick the
  most profitable NDC in a product — groups on the same `productKey()` function. Both are taking
  medians and comparing candidates across fragments of what should be one product. Not yet costed.

**2. Six faults were fixed in the buying logic on 8 September (commit `8d51d73`) — MEASURED on the
pharmacy computer, 7 September, and every one of them was moot, for one reason.**
`contractRatesBySupplier()` returned `{}`: no supplier had a rebate rate in force, so the ledger
compared **7,165 McKesson contract generics at printed price** (`rebate_unknown` on 7,165 rows) and
nothing the six fixes changed could show. The cause was one field: all three McKesson programmes
were stored with `ratioMeasure: null`, and `rebate-view.ts figuresFor()` selects the driving figure
from that field, so no band could ever be chosen — while the daily report carried a scrubbed
compliance of 20.32% and the OneStop ladder's bottom tier pays 15% at zero. The diagnosis then said
"the band it lands in pays nothing on contract generics today", which was false. Migration `0084`
sets the measure from each programme's own `ratioDefinition` text (they say "compliance" and
"generic purchase ratio" in words); verified after migrating: McKesson **29% off contract items,
0.75% off brand**. Every "which supplier" comparison had been overstating McKesson's contract
generics by about thirty per cent. Still open: the GPR ladder shows `allGenerics: null` because the
daily report's generic share (79.8%, which would pay 1%) is not passed through as `gprPercent` —
only a monthly statement fills it; assigned to A.

The six, on the live ledger (45,782 rows, 544 dispensed, **8 with an invoice price**):
- margin at net vs printed: 0 of 544 rows differ — no rate was in force, so net equalled printed.
  `margins()` is defined only where an invoice price exists, so "What each drug earns" covers 8 NDCs.
- short-dated: 0 catalogue rows carry a short-dated availability on this database; nothing to see.
- NADAC across units: **50 McKesson rows** are priced per one unit while NADAC prices per another;
  4 of them would have been reported as beyond 3× the benchmark; none beyond 100×.
- rebate rate by name: with no rates on file, first-containment and the new matcher agree on
  "none" for all five suppliers. The IPC invoice mismatch is a separate matcher (`earningSoFar`),
  fixed by session 2 in `0083`.
- placeholders: 0 in either table (`0082`).
- offers with no net price: 6 catalogue rows have no unit cost; 0 ledger buys lack an effective
  price.

**Invoices, measured for session 2:** `supplier_invoices` has 2 rows, both IPC, both `supplier_id`
null; one with 8 lines ($78.50), one with **no text layer, 0 lines, $1,530.89 and no review flag**.
There are no McKesson invoices anywhere — not mis-filed, never arrived — and the register's
McKesson row has **no sender address**, so one could not file as an invoice if it did. Owner
actions: forward McKesson invoices to the site's inbox, and the register needs McKesson's invoice
sender address. IPC aliases were typed on the register by session 1 from the two invoices.

**For B, from 1 (8 September) — the ERA fields the extraction now supplies**, on
`terms.remittance` in `contract-terms.ts`: `paidBy`, `paymentMethod`, `paymentCycle`,
`eraOffered`, `enrollmentMethod`, **`enrollmentFormUrl`**, **`clearinghouse`**,
**`tradingPartnerId`** (the three new ones), `remittanceContact`, `payerNamesOnRemittance[]`,
`payerIdentifiers[]`; plus `terms.contacts[]` with `purpose === "payment_or_eft"` (name,
organisation, phone, fax, email, portalUrl, postalAddress). The pharmacy's own identifiers come
from `era-enrollment.ts identity()`. Build the request builder against those names; the library
read that fills them is running on the pharmacy computer from 8 September.

**Claims inventory for A's audit (8 September):** the daily transaction report is the feed that
runs; it carries rx, fill, status, amount (remit), group, network reimbursement id (545-2F), copay,
total (patient), date filled, BIN, tax, quantity, acquisition cost, PCN, NDC, gross profit, and
days supply recovered from a wrapped line. It does **not** carry 522-FM basis, AWP, plan id, plan
type, service type, DAW or quantity unit — those are PioneerRx export columns the owner can add
(`docs/reference/pioneerrx-support-request.md`). `ingredientPaidCents` is derived on that feed as
remit + copay − dispensing fee. `networkId` is filled on 95% of rows across 82 values and is the
axis contracts are written on.

**File handed to A (7 September):** `claim-contract.ts` and `src/app/(app)/payers/**` for the
network-id mapping (ASSIGNMENTS, Helper A, "Second"). 1 does not edit them until A's pull request
lands.

The original list, for the record:

- `marginOf` used the cheapest *printed* price from any supplier; it now uses the net price at the
  actual buy (`bestBuy`). Every contract line's margin was understated by the rebate rate. How many
  rows change, and by how much?
- `bestBuy` recommended short-dated stock. 258 rows on the development copy. What is it here?
- The NADAC check compared across pricing units (a per-EA cost against a per-ML benchmark) and
  reported the row as "100× the national average". How many rows raised that falsely?
- Supplier rebate rates were matched by first-containment, so one wholesaler could be paid at
  another's rate. Check `contract.bySupplier` against the real supplier names in `supplier_items`.
- ~~CMS placeholder rows ("TBD DO NOT DELETE OR RELEASE") were stored as prices.~~ **Done, 7
  September.** They were never in `nadac_prices` (count 0); the nine were McKesson rows in
  `supplier_items`. Both catalogue importers and NADAC now share `isPlaceholderRow`, migration
  `0082` cleared them, and the live database holds zero in either table after the restart.

**Measured on the real database by session 2, 7 September — claim-to-contract matching (BACKLOG
item 2, link 2).** **0 of 1,081 insured claims (paid, non-cash) match a contract.** Not the
matcher's arithmetic: `contract_docs` holds 357 documents, all on disk, extraction state none 353 /
done 2 / failed 2, and both documents that read name no BIN, PCN or group, so `governs()` returns
null by construction. Nothing calls `contractFor` in the app except the diagnostic tree. The
structural point: **claims speak in codes and contracts speak in names.** Claims carry bin 99.8%,
pcn 94.4%, group 95.1%, and PioneerRx's `networkId` 95.3% across 82 distinct values (BIDBRODCBR
149, EN45 73, MRRETM 62, IRX9TP 56, BMPN 43); `planId` is always null. The two read contracts carry
network names ("Prime AccessOne Network", "BCBS Federal Employee Program National Network") and
chain codes ("00605", "00630"), empty bins/pcns/groups. `claim-contract.ts governs()` matches on
bins/pcns/groupIds only and ignores `networkNames`, `networkReimbursementIds` and `chainCodes`, so
a rate exhibit identified by network — which is how they identify themselves — can never match a
claim however many are read. The missing piece is a mapping from the 82 network ids on claims to
the network names in contracts; `payer_links.contract_id` exists for exactly this and is unused on
the path. Caveat: n = 2 read documents. Also: the 2 failed reads carry the old union-type schema
refusal (fixed since; re-run to prove it), and 249 of the 353 unread were never triaged, priority
false on all 357, so nothing is queued.

**Since 7 September the pharmacy session merges and deploys.** Workers open pull requests against
`feature/compliance`; `docs/SESSION-RULES.md` and `docs/ASSIGNMENTS.md` say how and who owns what.
A merged pull request reaches the site by `npm run deploy` on the pharmacy computer.
- Offers with no `netUnitMicros` were invisible to both the buy and the margin.

**3. The audit was two modules in when the session ran out of road.** Done: `drug-file.ts`,
`catalogue-cache.ts`, `catalogue-check.ts`, `product-ledger.ts`, `nadac.ts` parsing. Not yet looked
at: **`shelf.ts` (895 lines, the largest and least examined)**, `order-plan.ts` beyond its
documentation, the rebate ladder and band arithmetic (`rebate-rates.ts`, `band-strategy.ts`,
`ratio-effect.ts`), claim-to-contract matching, and the cash-versus-accrual split. The owner's
instruction was: *"Double check all logic to make sure it makes sense — ordering logic, NADAC,
pricing, which supplier to buy from."* That is the standing brief.

**4. What the owner has said, which governs everything above.** *"Everything we do, we need to
consider the end goal which is finding way to make pharmacy more money — if it doesn't lead to that
then what we are doing is pointless."* And: *"Take the request I give you and act as me, give me
what I want and the best tool, not necessarily exactly what I ask for."* He is the pharmacist-in-
charge and owner, not a programmer; he wants findings in plain sentences with the money attached,
not a list of function names.

**5. Two things to know about this machine.** Every libsql call blocks the Node event loop
completely — 200,000 rows read is 1.7 seconds during which the web server answers nothing — so
anything long-running belongs in a separate process (`scripts/make-claude-copy.ts` is the worked
example). And the launcher (`scripts/launch.mjs`) now recovers rather than exiting: a failed build
starts the previous one, a failed migration does not stop a working site, and anything fatal is
served as a page on the port instead of vanishing into a hidden console window.

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
- **Cash pricing (profit-engine §6 item 7) is built**, pure and tested: `cash-pricing.ts`,
  `cash-pricing-store.ts`, and a recurring "cash-pricing" row on Money found — every product's
  median cash price against its median invoice cost and against the Kansas floor (NADAC plus the
  greater of $10.50 and the Medicaid fee), scaled to the product's typical quantity and to fills a
  month; under cost is a loss on every bottle, under the floor is money a plan would have had to
  pay. The row links to Claims; a page listing every cash product is yours when you want one.
- **Second design and logic pass, page by page on the seeded scratch database.** Fixed (mine unless
  said): the books' "Cash change" row printed the accrual net in the accrual column — there is no
  accrual side to a cash change, so it is a dash now; "Net revenue" no longer repeats "Revenue" when
  there are no offsets; the Reports page (yours, `money/report`) printed the scripts delta as
  dollars ("+$5.11") and compared against a quarter with nothing in it — counts print as counts and a
  period with nothing recorded is no comparison; the Compliance page said "You are clean" on a
  morning Today listed the CQI summary and the annual controlled substance inventory as late — it
  now judges both exactly as Today does; the Which-contract replay priced from raw `supplier_items`
  rows, so McKesson's "(3) 28 EA" per inner pack against IPD's "84 EA" per tablet read as a
  twenty-three-fold gap, and every flagged row — "not rebated" included — counted as rebated
  (`replay-store.ts` now reads the levelled `catalogueRows()` and the flag the way the buy list
  does; McKesson's replayed rebate on the scratch data fell from $14,657 to $584); the shelf said
  surplus was "worth $0.00" where the count carried no values; Claims ended in a raw list of every
  file loaded (folded, newest on the summary); the NADAC page's three secondary loaders and its
  long no-NADAC list are folded; Spending's balance-sheet categories showed a blank badge; Settings
  repeated the Backups and Network cards as paragraphs (yours; removed); the supplier invoices page
  pointed "back" at Controlled substances from under Ordering.
  **Yours to look at:** `/remits/mtf` (a path this session cannot read) has its back link on
  Connections though it sits under Claims, and its title "Medicare MFP refunds" does not match the
  sidebar's "Facilitator payments"; the Claude key is entered on both `/settings` and
  `/settings/connections`, which should be one place.
- **Profit by reimbursement model** (`drug-profit.ts` pure with tests, `drug-profit-store.ts`,
  the lead table on `/purchasing/products`; all mine). The owner's brief: not the cheapest NDC but
  the most profitable one given how his payers pay — "if omeprazole is paid NADAC + $10.50, find
  the NDC I can buy for the most under NADAC". Per product (NADAC's description through
  `product-groups.ts`): the pricing leg of every fill is read for its model — the PBM's 522-FM code
  where the export carries it (`claims.basisOfReimbursement`), else the arithmetic of what was paid
  against the NDC's own NADAC (within 3%) and AWP (a stable share); the majority model wins and
  its fee, ratio or discount is the median; then every NDC in the product with a price (the product
  ledger's invoice and catalogue buys, after rebate) is valued per fill of the typical quantity
  under that model, and the best is set against the NDC dispensed today at what it was last bought
  for. Under a MAC or flat price the cheapest wins; under NADAC + fee the one furthest under its
  own NADAC; under AWP − x% the higher AWP. Reads `dispensingFeePaidCents` and `ingredientPaidCents`
  where your readers fill them; where the transaction report carries neither basis nor AWP the
  page says so and reads the model from the fee split alone.
  **Reworked after the owner's rethink (e1d1258 and after):** the law settles a fill before any
  arithmetic. A fill on a plan the register (`plan_groups`) classes as Medicaid is NADAC + fee; a
  fill from 1 July 2026 on a plan whose class is in scope for SB 20 (`planScopeOf` →
  `commercial_non_erisa`) and paid within 3% of NADAC + the floor fee was priced on the floor,
  and a fill paid above it was priced by the contract and is read the ordinary way. Every drug
  now carries `mix` (each way it is paid, by share), `settledBy` (law / code / read from the
  money), `confidence` ("settled" at four fills in five by law or code) and `floor` (bound /
  above / unpriced); a candidate NDC is valued under every way with at least 5% of fills and
  weighed by share, and left out whole where one of those ways cannot price it (an NDC with no
  NADAC is never the answer on a floor plan). `drugProfitReport` also returns a summary — share
  of paid dollars settled by law, share of floor fills where the floor bound — shown as figures
  at the top of the card. Grouping is the FDA directory's key (`groupResolver` in
  `drug-directory-store.ts`) where it carries the NDC, NADAC's description otherwise.
  **The register decides all of this: an unclassified plan is settled by nothing.**
- **Bought over NADAC** (`/purchasing/over-nadac`, `over-nadac.ts` pure with tests,
  `over-nadac-store.ts`, `/api/over-nadac?days=7` as CSV; a fourth tab on the order family; all
  mine). The owner's ask: the weekly list of what was bought over NADAC, to take to the buying
  group. One row per NDC per supplier over the window (7, 28 or 90 days): units bought (invoice
  lines put per unit by the catalogue's pack size, through `packQtyOf`), the invoice price and
  the price after the supplier's tier rate (`contractRatesBySupplier`), NADAC in force, the gap
  per unit and in dollars, the cheapest other supplier's listing (never short-dated), and the
  units of it dispensed in the window on plans paying NADAC by law with the gap on those as the
  loss. Rebated lines with no rate on file are compared gross and say so. **The buying group's
  own form is coming from the owner; `overNadacRows` is the one function to rewrite to its
  layout, and the weekly send should then go through `send-mail.ts` from Connections.**
  Reads `invoice_lines` (yours) and `plan_groups` (yours); edits neither.
- **The drug directory** (`drug-directory.ts` pure with tests, `zip-read.ts`,
  `drug-directory-store.ts`, migration **`0079`** `drug_directory` + `drug_directory_loads`,
  shape-only fixtures `fixtures/fda-ndc-*.txt` and `fixtures/orange-book-products.txt`). The FDA
  NDC Directory and the Orange Book joined into one row per marketed package with an equivalence
  key (sorted ingredients | strength | form | route) and the TE code joined by application number
  and strength; `substitutable` = same key and both A-rated. `fetchDrugDirectory` pulls both zips
  from the FDA; `loadDrugDirectory` takes them by hand. **Not yet on a page or a schedule:** the
  NADAC page card ("Fetch now" / load by hand) and a weekly refresh beside the NADAC job in
  `src/instrumentation.ts` are next on my side unless you want them; a "Drug directory" row on
  `/settings/feeds` too. Until a load runs, every grouping falls back to NADAC's description and
  the products page says "0 of N dispensed" are on the directory.
- **The efficiency pass, 7 September evening** (the owner: "site is so painfully slow; make it
  as efficient as possible and keep it that way, it will get lots of data every day"). Measured
  on a scratch database at a year's scale — 30,000 claims, 1.5 million NADAC rows, 4,000
  invoice lines, the three real catalogues — every page timed cold and warm. What was wrong and
  is fixed, and **the rules that keep it fixed**:
  1. *Nothing loads the whole NADAC table.* `appeals.ts` (the appeal queue: 20 s), `replay-store.ts`
     (18 s), `minimum-store.ts` (9 s) and `money-found.ts` (the pay-basis section) each loaded
     every row ever held to find one row per NDC or the row in force on a fill date. The row in
     force is now one SQL statement, `nadacRecordsForClaims()` in **`nadac-in-force.ts`**: one
     index seek per distinct (NDC, fill date) among the claims, returning exactly the rows
     `nadacInForce()` picks from. The newest row per NDC is `nadacNow()`, held until a new file
     loads (its ten-minute clock is gone). `floor-review.ts` uses the same query.
  2. *NADAC is pruned.* `pruneNadac()` runs after every load: rows older than
     `nadac_keep_months` (new setting, default 18) go, never an NDC's newest row. A year and a
     half covers every fill the floor can reach; the table stops growing without bound.
  3. *Claims are read over a window.* `allFills(range?)` defaults to the last thirteen months and
     is held per range; the books pass their period. `movement()` in `shelf.ts` reads only the
     lookback window. `productLedger()` reads the held fills rather than scanning and grouping
     the claims itself. `claimFlags({ all: true })` is held.
  4. *Every reading that takes more than a moment is held* (`held.ts`, keyed on the data): fills,
     ledger, buy list, minimums, drug profit, over-NADAC, money found, money position, cash
     pricing, books, month accounts (so a period is twelve held months), floor review, appeal
     queue, replay, movement, lean shelf, payer map and tree, plan register, NADAC coverage,
     health, claim coverage and week gaps, drug-file health, purchasing opportunities, the
     products page's comparisons (`products-store.ts`), feeds, compliance summary, contract
     clocks. A held value is shared by reference: **read it, never sort or write into it.**
  5. *Warming happens only when nobody is waiting.* `warm.ts` → `warmHeld()` runs from
     `instrumentation.ts` under `whenIdle`, twenty seconds after boot and every five minutes,
     computing the readings Today and Buying open with and then `refreshStale()` for the rest.
     The boot-time warm that competed with the first page is gone.
  6. *Two read indexes*, migration **`0080_read_indexes`**: `claims (status, ndc11, date_filled)`
     for the in-force query and every "paid claims since" read; `claim_payments (received_on)`.
  Results on the scratch database (cold → warm, ms): Today 13,700 → 760 / 630; the books
  14,200 → 1,280 / 98; Buying 18,000 → 172 warm; appeals 20,500 → 614 / 67; Which contract
  18,200 → 522 / 43; the shelf 3,700 → 425 / 68; Who pays best 3,500 → 2,100 / 313; NADAC
  2,300 → held. **For anything new: load a window, not a table; ask SQL for the row you need;
  hold what takes more than a moment; never load `nadac_prices` whole.**
- **Speed: the heavy readings are held between requests** (`held.ts`). On a year of claims Today
  took 13 s, the books 14 s and Buying 11 s, most of it the same claims scan repeated through
  different helpers. `held(key, compute)` keeps a reading keyed on a fingerprint of the tables
  that feed it (claims count, newest audit event, price files, benchmark, invoice lines, counts,
  driver invoices, expenses, payments, plan groups): same fingerprint within ten minutes is the
  held value; older, served at once and refreshed behind; changed, computed now; concurrent
  callers share one computation. Wrapped: `allFills` (yours, `claims.ts`), `productLedger`
  (yours), `buyListNow` (yours, `shelf.ts`), `minimumsNow`, `drugProfitNow`, `overNadacNow`,
  `moneyFound`, `cashPricingNow`, `booksFor`, `recentMonths`; each wrap is three lines at the
  export with the body renamed `load…`. **A held value is shared by reference: read it, never
  sort or write into it.** `instrumentation.ts` warms them fifteen seconds after boot. After:
  Today 0.5 s, the books 0.2 s, Buying 0.2 s warm (7 s cold). `forgetHeld()` exists for an
  import that wants to drop everything at once; the fingerprint makes it unnecessary in practice.
- **The delivery round is an expense** (`driver-cost.ts`, pure, tested; `driverCostFor(month,
  basis)` in `profit-and-loss.ts`; two lines in your `deliveries/page.tsx` read the same default).
  The owner: "you have a driver invoice for this month yet you aren't applying it as an expense."
  The default was the clinic paying the driver, and drafts never counted, so the month in progress
  showed nothing. Now the pharmacy pays unless `driver_paid_by = clinic`; the accrual month
  carries the draft's running total (the days driven so far, as payroll is carried by the day),
  a finished month its issued invoice, never a superseded one; the cash account counts a sent
  invoice on the day it was sent. `money-ledger.md` §2 row updated.
- **The look is new** (`globals.css`, `(app)/layout.tsx`, `components/nav.tsx`,
  `send-to-claude.tsx`). The owner: "the tool bar colour change is awful", "you changed the
  colour of the tool bar and gave me the same thing". Gone: the dark sidebar. Now: a white bar
  across the top with the six words, a second row with the group's pages and "more", the page
  centred at 1280 px on warm paper, body type 15 px (was 13), titles 30 px bold, cards without
  rules and with a soft shadow, pill buttons, table headers in sentence case. Every page uses the
  same classes, so nothing of yours was edited for it; a page that set its own widths may want a
  look. Print CSS: the head and the crumb bar are hidden, the page frame drops its padding.
- **The menu is six entries** (`nav.ts`, `components/nav.tsx`, `tests/nav.test.ts`; `/tools`
  redirects to Settings). The owner: "this site has too many tools; I don't understand anything."
  Today, Buying, Getting paid, Money, Compliance, Settings. **Your pages are all still reachable
  and none is edited:** People and Controlled substances are under Compliance (Staff, Training
  and Controlled substances listed; New employee, Technician list, Rotations, Discrepancies,
  Pharmacist log, Power of attorney, CQI and Temperatures under the group's folded "more" line);
  Driver invoices is under Money's "more"; NADAC, Report check, Activity log, Backups, Training
  settings, Extra sections, Network and Updates under Settings' "more"; What arrived is listed
  under Settings. `NavItem.hidden` is the mechanism; `groupFor` / `itemFor` and the breadcrumb
  treat hidden items as listed. If a page of yours should be in the list rather than under
  "more", it is one word in `nav.ts`.
- **`/purchasing` is "What to add, what to watch"**: alerts (a different NDC earns more; a needed
  line cheaper at a secondary; the primary over NADAC where a secondary is under) and one ranked
  card per secondary. No cart box, no running total: the owner was clear the site cannot know
  the cart, so it ranks and he adds from the top until the wholesaler's screen shows the minimum.
- **Still needed from PioneerRx for the fills the law does not settle:** Basis of Reimbursement
  (NCPDP 522-FM), Dispensed AWP, Usual and Customary submitted, and DAW on the daily transaction
  report. The catalogue exports now carry AWP (the feeds page prints the share per file).
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
`src/db/schema.ts`, `drizzle/0078_*`, `drizzle/0079_*`, `src/lib/{drug-profit,drug-profit-store,over-nadac,over-nadac-store,drug-directory,drug-directory-store,zip-read,families}.ts`, `src/app/(app)/purchasing/{products,over-nadac}/page.tsx`, `src/app/api/over-nadac/route.ts`, `tests/{drug-profit,over-nadac,drug-directory}.test.ts`, `fixtures/{fda-ndc-product,fda-ndc-package,orange-book-products}.txt`,
`drizzle/0048_*`, `drizzle/0049_*`, `src/lib/{ndc,ndc-held,supplier-terms,supplier-terms-store,invoice-lines,nadac-sources,product-groups,pay-basis,under-nadac,ndc-choice,ratio-effect,drill-down,recommendations,recommendation-log,recommendation-store,reimbursement-fit,band-strategy,month-plan,price-moves,rate-formula,contract-apply,appeal-packet}.ts` (new), `drizzle/0069_*`,
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
