# What the owner has asked for

Everything the owner says, written down the moment he says it, whether or not it is being worked
on. He types while a session is working and does not expect it dropped or acted on immediately.
Nothing leaves this file because it was inconvenient; a line leaves when it is **done and
verified against the real database**, and moves to "Done" with the number that proves it.

`docs/HANDOFF.md` remains the channel between the two sessions. This file is the owner's queue.

## The standing brief

> "Everything we do, we need to consider the end goal which is finding way to make pharmacy more
> money — if it doesn't lead to that then what we are doing is pointless."

> "Take the request I give you and act as me, give me what I want and the best tool, not
> necessarily exactly what I ask for."

> "Double check all logic to make sure it makes sense — ordering logic, NADAC, pricing, which
> supplier to buy from."

**Order of work, in the owner's words (7 September):** *"Help keep building the base of this site,
the data ingestion, and once we have a solid base and the site is getting everything it needs we
will start to help improve profits."* So: ingestion and arithmetic first, profit tooling second.
The math has to be perfect — a wrong number that looks right is worse than no number.

## Now

### 1. The drug catalogue has to be sound (7 September)

The owner's four requirements, each of which is a thing the catalogue must be able to state for
every drug it carries:

- **Which drugs are equivalent.** This is the weak one. `productKey()` builds the grouping key out
  of each supplier's own description text, and the wholesalers write in their own shorthand, so the
  same drug fragments: **10,429 NDCs carry more than one product key**, and **64% of catalogue rows
  (40,728 of 63,818) come out with no dosage form at all** because the keyer knows `tab` and `cap`
  but the catalogues say `TB`, `CP`, `OS`, `SS`, `CPLT`, `PFS`, `SDV`. **7,655 McKesson rows key to
  nothing at all.** Mounjaro 12.5mg is three products; Trulicity 0.75mg is three. This reaches
  money directly: `reimbursement-fit.ts` takes a median MAC per product key to decide a payer's
  formula, and `product-groups.ts` feeds `drug-profit.ts`'s choice of the most profitable NDC in a
  product. Both are averaging across fragments of one product. **In progress.**
- **Price from each supplier, including rebates.** Proven wrong and fixed 7 September: no rebate
  rate was in force for any supplier because McKesson's three ladders never said which ratio drives
  them, so 7,165 contract generics were compared at printed price — about 30% too high. Migration
  `0084`; McKesson now 29% off contract items. Still to do: the GPR 1% off every generic (A), and
  **the owner's actions** — forward McKesson invoices to the inbox and give the register McKesson's
  invoice sender address, because there is not one McKesson invoice in the system and the rebate
  earned-so-far figures run on invoices.
- **NADAC of each drug.** Answered 7 September and sound: 26,246 of 45,791 catalogue NDCs, and 652
  of the 681 NDCs actually dispensed, 650 of those current within three months. The misses are CMS
  genuinely not pricing hospital injectables, devices, supplies and repackager labels — not a
  formatting fault, and not fixable by a product-level proxy (that would rescue 197 NDCs, 0.4%).
- **The supplier's own item number, per supplier.** Done 8 September: all five suppliers
  **100%** (McKesson 44,242 of 44,242). McKesson's read as zero only because its stored catalogue
  was imported on 6 September, before the code that reads the column reached the site; the parser
  reads every one, and re-running the stored file through the importer filled them. Nightly
  imports keep it so. Note: no McKesson catalogue arrived on 7 September (the other four did).
- **Pack sizes, against the FDA (8 September).** The levelled catalogue agrees with the FDA
  package on about 95% of rows at every supplier. The rest: 0.5–1% where the FDA is a whole
  multiple of the catalogue (IPD "30 EA" for 30 blister packs of 6 = 180, a sixfold unit-cost
  error), 2.5% where the unit differs (GM against EA), 1.5% other — and many of those are the
  FDA *reading* being wrong, because `packageUnits` takes the outer count ("3 BLISTER PACK") and
  ignores the inner ("28 TABLET in 1 BLISTER PACK"). The parser has to read the nested description
  to the innermost unit. Assigned to session 2 as the Data health row it belongs to.
- **AWP where a supplier prints none.** Done 8 September: the levelled catalogue carries the
  newest printed AWP for the NDC onto every row of that NDC that has none, naming the lender
  (`borrowAwp`, `awpBorrowedFrom`). Rows with an AWP went from **50,870 to 59,741 of 63,809**
  (79.7% → 93.6%); IPD 95.3%, ParMed 96.9%, where both had been zero. The 4,068 still without are
  NDCs no catalogue prices at AWP.

### 2. Every claim matched to its contract, and to the formula that priced it (7 September)

The owner's chain, in his words: *"The contracts in the folder need to be understood as much as
possible. Goal is to match a specific claim to a specific contract so we can gather its
reimbursement formula — ie is based on NADAC, AWP, MAC, because this will tell us the best way to
make a higher profit on that claim. If we can do that for all claims we can start to identify which
drugs to buy and from where that would net us highest profit."*

This is the spine of the whole site, and it is the thing that turns the base into money. It runs in
four links, and it is only as good as its weakest:

1. **Read the contract.** Built and running live — `contract-extract.ts`, the folder sort
   (`/payers/sort`), `proposeFromContract` with `governs` and `quoteFound` so a document that is
   not ours, or a rate whose quote is not in the text, is refused rather than applied.
2. **Match a claim to the contract that governs it.** Partly built — `claim-contract.ts`,
   `payer_links`, `plan_groups`, BIN/PCN/group. **Measured 7 September: 0 of 1,081 insured claims
   match a contract.** Only 2 of 357 contract documents have been read, and the matcher looks for
   BIN/PCN/group while rate exhibits identify themselves by network name and chain code; claims
   carry PioneerRx's network id (82 distinct values). Two jobs follow: read the library (re-run the
   2 stale failures, triage the 249 never triaged, queue by dollars of claims behind each payer),
   and teach the matcher the network id → network name mapping that `payer_links.contract_id` was
   made for. Full numbers in `docs/HANDOFF.md`.
3. **Name the formula that priced the claim.** Two readers exist and they should agree:
   `reimbursement-fit.ts` infers the formula from what was actually paid, and the contract reader
   takes it from the document. Where the export carries the PBM's 522-FM basis code
   (`claims.basisOfReimbursement`) that is a third opinion. **Where all three are available they
   should be set against each other — a disagreement is either a misread contract or a claim
   matched to the wrong one, and both are worth knowing.**
4. **Turn the formula into a buying decision.** Started — `drug-profit.ts` values every NDC in a
   product under the payer's own model: under a MAC or a flat price the cheapest NDC wins, under
   NADAC + fee the one furthest *under* its own NADAC, under AWP − x% the higher AWP. This is
   exactly the owner's omeprazole example.

**Link 3 and link 4 both depend on item 1 above** — they group by product key, and the product key
currently fragments. Fixing the key is the prerequisite, which is why it is first.

### 2b. Contract ingestion is session 1's own job (7 September)

The owner: *"I want you handling the contract ingestion. All the contracts are in the contract
folder. The goal is to extract as much info as we can to match claims with a contract. So you
should be familiar with all the info we get from claims."* Session 1 reads the whole library —
357 documents, 353 unread, the 2 stale failures re-run — in a separate process, queued by the
dollars of claims behind each payer, and widens what the reader extracts to every identifier a
claim carries (BIN, PCN, group, network reimbursement id, chain code, NCPDP, NPI, plan names) and
to the 835/EFT/EDI enrolment instructions below. The claims side of the join is inventoried first
so nothing extractable is left unasked.

### 2b-ii. The payer model: payor → contract → plan → claim → payment (7 September)

The owner: *"Once contract ingestion is done, you need to make sure the contract info (plans,
groups, bins, payors) are organized in best way possible to not only match claims to contract and
reimbursement but also to payors. To know the reimbursement of a claim we need to know the specific
contract id (group #, etc) but payments come from the payor (ie Caremark, Blue Cross, Optum, etc).
Payors will have many different BINs and groups under them. We also need to be thinking of data we
will need to completely reconcile payments to claim when we start getting 835s."*

Two different questions, which today are muddled into one `pbmName` string:

- **Who priced it** — the contract. Reached from the claim through its routing (BIN, PCN, group,
  network reimbursement id, days supply, line of business) to a rate line with a formula.
- **Who pays it** — the payor. Reached from the 835 through the payer name on the remittance
  (N1*PR) and payer id, and from the bank through the deposit descriptor. One payor has many BINs,
  PCNs and groups under it, and one contract (a PSAO's, say) can price claims that several payors
  then pay.

The read so far confirms what the data has to look like: of 86 contracts read, 63 identify
themselves by network name, 39 by chain code, 5 by BIN, 0 by network reimbursement id — so the
contract side is named by network, the claim side is coded by BIN/PCN/group/network id, and the
join between them is a table the pharmacy fills once per network id, not a string match.

**Drafted 8 September — `docs/reference/payer-model.md`, with A to audit before any migration.**
The deliverable as first stated: `docs/reference/payer-model.md` defining
the entities and their keys — payor, processor/PBM, contract document, rate schedule, network,
plan (BIN/PCN/group), claim, remittance, deposit — with one canonical name per payor, the
existing tables (`payer_bins`, `plan_groups`, `payer_links`, `network_rates`, `payment_routing`,
`era_enrollments`) mapped onto it, and the migrations that make it so. Then the payers page shows a
payor as a tree: its BINs and groups, its contracts, its enrolment state, its receivable.

**What a claim must carry to be reconciled against an 835 later** (for B's ERA work and the
PioneerRx export ask): the pharmacy's claim reference that will come back in CLP01 (the Rx number
and fill as submitted), the PBM's authorization number (NCPDP 503-F3), the payer claim control
number if returned, date of service, NDC, quantity, submitted and adjudicated amounts by component
(ingredient, fee, tax, copay), and the BIN/PCN/group. From the 835: N1*PR payer name and id, the
TRN trace (check/EFT number and amount), each CLP with its CAS adjustment codes, PLB provider-level
adjustments (DIR, recoupment, fees) — which are money that belongs to no single claim and must
still reach the books.

### 2b-iii. Provider manuals do not fit one read (8 September)

Twelve documents ran past the reader's 32,000-token answer limit — every provider manual in the
library (CVS Caremark 2025 state addenda 256 pp, ESI 2026 state 182 pp, Capital Rx 2025 151 pp,
ESI 2026 federal 142 pp, CVS Caremark 2026 114 pp, Liviniti 2025 66 pp) and five smaller ones that
should not have (Aetna 2015 Medicare D 51 pp; four of 1–18 pages, which suggests the answer looped
rather than the document being long). Manuals carry appeal windows, DIR and audit terms, not rates.
Needs a read-in-parts path in `contract-extract.ts` (page ranges, one answer per part, merged with
citations kept) and a retry of the four small ones. Session 1. Also: three documents were refused
*whole* because one field, `dirFeeBasis`, came back without a quote — `requireCitations` treats it
like a rate. A rate without its sentence is unusable; a DIR basis without one is a field to drop,
not a reason to lose the counterparty, the networks and every contact on the document. **Done 8 September:**
the uncited value is dropped and named in `unclearOrMissing` (`dropUncited`), a rate without its
words still refuses the read; and contract runs now count toward the site's own ceiling
(`spend()` reads `contracts.*` audit rows as well as `ai.*`). Still to do: the read-in-parts path
for the manuals, and re-reading the three refused documents once the console limit is raised.

### 2b-iv. Claims with secondary payors: profit by payor, and who owes what (8 September)

The owner: *"We need a deep audit of how we handle claims with secondary payors! We need to make
sure the profit and loss of these claims are correct, we need to make sure we know how much money
we are expecting from each payor. I've noticed we tend to assert all the profit to one payor which
doesn't make sense. We need to really think this through from a profit perspective as well as what
to expect when we start receiving remit payments (who owes us what) so that we can reconcile
properly."*

One fill, several transmissions, each to a different BIN: the primary adjudicates, the secondary
picks up some of the patient's share, sometimes a third. Today `fills.ts` groups the transmissions
into one fill and sums their revenue, which is right for the fill's margin — but anything that
reports *by payor* then hangs the whole fill's profit on one of them. Two things have to be true
at once and are not the same figure:

- **Profit belongs to the fill**, not to a payor. The fill has one acquisition cost and one total
  revenue (every payor's remit plus what the patient finally paid). It is a whole or it is nothing.
- **Money owed belongs to each payor separately.** Each transmission is its own receivable: this
  BIN owes this remit for this claim, and it is settled by that payor's 835, not by anyone else's.
  A secondary's remit is a residual after the primary, and a coordination-of-benefits row can carry
  a zero acquisition cost on purpose (the drug was costed on the primary row).

So the audit has to answer, on the real claims: how many fills have more than one payor; how the
site attributes their revenue and profit today, page by page; whether any figure double-counts the
acquisition cost or the patient's share across rows; and what "expected from payor X" should be
defined as so it reconciles line by line when the 835s arrive. Assigned to A (audit, first item on
the claims audit) with session 1 supplying the counts. The fix follows the audit.

### 2b-v. Fees on 835s have to be classified, and the contracts hold the key (8 September)

The owner: *"We also need to start thinking about how we are going to handle and classify fees that
come over with 835s. These will need to be accounted for properly. Fees often come over with a code,
we might need to get codes from contracts in order to decipher what that fee is."*

An 835 carries adjustments at two levels: on the claim (CAS segments, with a group code and a Claim
Adjustment Reason Code — CO-45 contractual, PR-3 copay, and so on) and on the provider (PLB
segments, with a reason code such as WO, FB, L6, 72, and a reference the payor chooses). The
standard code sets say the *kind* of adjustment; what a given PBM's "L6 — TRANSACTION FEE" or
"DIR-Q2" actually is comes from the contract, where `transactionFees[]`, `postPointOfSaleDiscounts[]`
and `dirFeeBasis` are already extracted. Deliverable: a fee dictionary — standard CARC/RARC and PLB
codes with their meaning, joined to each PBM's contract-named fees — so every adjustment on an 835
lands in the books under the right heading (contractual write-off, patient share, DIR, transaction
fee, recoupment, interest) and none lands as "other". Assigned to B with the ERA work; the
extraction side (making sure the reader captures every fee a contract names, with its code where
printed) is session 1's.

### 2c. Get the 835s sent here (7 September)

The owner: *"Also want to search contracts for info to request 835 changes. Want to automate request
to have 835s sent to this site instead of where they currently go!"* Two halves: the extraction
(session 1, inside 2b — for every contract, where remittance advice is delivered today, who
changes it, the form or portal or address, the payer ID, the clearinghouse) and **the request
itself** — one generated, ready-to-send enrolment request per payer, tracked from sent to
acknowledged to first 835 received, on `/payers/routing` (`era-enrollment.ts`, `era_enrollments`,
`payment_routing`, `pbm_contacts` already exist). Assigned to B, ahead of the inbox recogniser.

### 2d. Claims data joins the audit list (7 September)

The owner: *"We also need to add claims data to the list of things to audit."* The claims reader
(`claims.ts` and every column alias it accepts), fills grouping (`fills.ts`), payments
(`claim-payments.ts`), and the reimbursement inference (`reimbursement-fit.ts`) — audited like the
buying logic: one meaning and one unit per figure, nothing inferred that the export states, and
every figure the profit chain uses traced back to the export column it came from. Assigned to A
after the contract match; session 1 supplies the real-data queries.

### 3. Re-measure the six buying-logic fixes against real data (HANDOFF item 2) — DONE, see Done

Fixed on 8 September in commit `8d51d73`, none measurable at the time. Each needs a real number:
margin at net rather than printed price, short-dated stock being recommended, the cross-unit NADAC
false alarms, rebate rates matched to the wrong wholesaler by first-containment, and offers with no
`netUnitMicros` being invisible to both the buy and the margin. (The sixth, the CMS placeholder
rows, is done — see below.)

### 4. The Money tab has to be sound, complete and free of double counting (7 September)

The owner's words: *"The money tab needs to have sound logic, needs to not forget about expenses or
revenue it knows, needs to not double count things. This is how I will track financials of pharmacy.
It should be able to operate on a cash and accrual basis. It needs to take into account everything
and needs to do it correctly."*

This is his books, not a report — so the bar is a bookkeeper's bar, not a dashboard's. What that
means concretely:

- **Nothing counted twice.** The live risk is named in `docs/HANDOFF.md`: two period modules landed
  the same night and both are wired into the sidebar. `period-account.ts` + `periodAccount()` /
  `monthlyTrend()` + `/money/report` (pharmacy session) and `ledger.ts` + `ledger-store.ts` +
  `/money` (cloud session) read the same claims and expenses by two different routes. One has to
  absorb the other before either can be trusted as "the books". The cloud session proposes keeping
  `/money/report` and `period-account.ts` as the reporting surface with its `loadShared()`
  underneath — which is also a speed fix, because `periodAccount()` and `monthlyTrend()` currently
  read every claim once per month, twelve full passes for a year, where `loadShared()` reads once.
- **Nothing forgotten.** Every feed that carries money has to reach the books: claims, remittances,
  supplier invoices, other expense invoices, MTF/facilitator payments, cash receipts, bank lines,
  rebates. Each one needs to be traceable from the statement back to the document it came from.
  Rebates in particular are a reduction in cost of goods, never revenue (`expense-categories.ts`) —
  putting them in revenue overstates both sales and cost.
- **Cash and accrual both, and the difference explained.** The owner's rule (7 September): *"System
  total accrual shows how much we collected in copays, this should be received on cash side, but
  third party payments shouldn't until we get the 835 or remit. For accrual side, both should be
  accounted for that month."* Copays are cash when collected; payer money is cash only when the 835
  or remit arrives and a receivable until then; accrual books both in the fill month. Assigned to A
  with a required fixture. A cash change has no accrual side and must print as a dash rather than a
  number — that was already caught once on the books page.
- **Checked by arithmetic, not by eye.** Per CLAUDE.md: every reader that decides money is checked
  by arithmetic before anything is stored. The books should be able to prove they balance.

### 5. The inbox has to know what arrived, and let the owner say when it doesn't (7 September)

The owner's words: *"I have an email integrated into the site, so that I can automatically send
invoice, catalogs, claims, etc to this email to get into the site. The tools I have on this inbox
folder need to be a lot better and a lot smarter. The inbox should eventually be able to know
what's coming in based off name, email, contents but I also need tools on this page to route things
exactly where they need to be or tell system exactly what we received. There will be numerous
things coming to this email from employee compliance documents, to supplier catalogs, to expense
invoices, to more. It needs to be able to handle it all allow me to tell it what it received. From
there it should know how to use it."*

Two halves, and the second is the one that must never be missing:

- **Guess well** — from sender address, sender name, subject, attachment name and file contents.
  The routers that exist (`mailbox.ts`, `looksLikePioneerCatalog`, `looksLikeNadacHeader`,
  contract triage) each know one shape; the inbox needs one place that ranks all of them and says
  how sure it is and why.
- **Always be correctable** — the owner tells it what a document actually is, and it is then
  handled as if it had been recognised. A guess that cannot be overridden is worse than no guess,
  because the document goes somewhere wrong and silently. The override has to be on the page, in
  his words, not a re-send.

Categories seen so far: supplier catalogues, supplier invoices, expense invoices, claims exports,
NADAC files, reimbursement contracts, employee compliance documents, ERA enrolment, appeals,
MTF/facilitator remittances. The list will grow, so the design has to take a new category without
a rewrite.

### 6. PioneerRx over SQL — the tables have to be ready for it (7 September)

The owner's words: *"I am in the process of trying to get info from PioneerRx via SQL request. This
should allow us to get much better info and more efficiently about our claims and catalogs. But you
will have to build the tables to request this info. Just keep that in mind."*

A direct read replaces file exports for claims and catalogue, which removes a whole class of
problem: no column-name guessing, no export that silently drops a field, no waiting for a file. It
also changes what the site should store — a direct read can be re-run, so the tables want to be
shaped around what PioneerRx actually holds rather than around what its export happened to print.
`scripts/pioneer-discover.ps1` and `scripts/pioneer-locate.ps1` already exist for finding it.

**His sequencing, which is the order of this file:** *"Once our drug file is sound and does all the
things above, the next part is going through the contracts to see how we can efficiently match
claims to a specific contract."* Drug file first, then claim-to-contract matching.

**What to pull once SQL is connected (8 September, 1, the owner: "we should be thinking about all the
info we will want to get from sql").** Per claim: everything in the dispensed export (AWP, WAC, NADAC,
MAC, DAW, days supply, fee, basis of reimbursement, contract id, received plan id, DIR fee,
e-voucher, secondary payer) plus the EDI response itself — the network reimbursement id, the
response messages, reject codes, other-payer amounts — and the timestamp of every transaction and
reversal. Per fill: sold date, quantity, the dispensed NDC, a hashed patient key, never a name.
Third-party setup: every plan with BIN, PCN, group, plan name and network. Pricing as PioneerRx saw
it at adjudication, per NDC and date. Inventory: on-hand daily, order points, the drug file. The
daily text report stays the automatic feed until then, proved nightly; the export enriches when one
is sent by hand.

**8 September evening (1) — the connection is built; the owner has the credentials.** He wrote: *"I have
info on how to access sql I have instance name, username, password, and sql database name … can you use
a sequel tool to build these reports for me?"* What went in: `src/lib/pioneer-sql.ts` (read-only intent,
READ UNCOMMITTED on every batch so nobody at the counter waits on a lock, one SELECT at a time, TLS with a
clear-text retry for an old server), a **PioneerRx database** card under Settings → Connections (server
or instance, database, user in the clear; the password encrypted like every other credential), the page
`/tools/pioneer-sql` (test the connection, read the table names into `data/pioneer-schema.json` — names,
types and row counts only, never a value — search them, run one SELECT capped at 500 rows, shown and
stored nowhere), and `scripts/pioneer-sql.ts` for the machine session (`test`, `tables [needle]`,
`query "select …"`). The reports themselves cannot be written until the table names are on the machine:
PioneerRx does not publish its schema. Order of work once they are: (1) the dispensed feed as a query,
proved against the daily text report for the same day before it replaces anything; (2) the third-party
plan table (BIN, PCN, group, plan name, network) for the linking chain; (3) the drug file with AWP, WAC,
NADAC as PioneerRx holds them; (4) on-hand and order points nightly. Each feed lands beside the reader it
replaces and proves itself the same way (SESSION-RULES §1c).

### 7. Finish the logic audit (HANDOFF item 3)

Not yet looked at: `shelf.ts` (895 lines, the largest and least examined), `order-plan.ts` beyond
its documentation, the rebate ladder and band arithmetic (`rebate-rates.ts`, `band-strategy.ts`,
`ratio-effect.ts`), claim-to-contract matching, and the cash-versus-accrual split.

### 8. The site has to look and work like a professional product (7 September)

The owner: *"Site needs a lot of work in terms of design and usability functions! Are all the tools
there that are needed? Are we presenting info in clean, clear way? This site should look and
function like a professional website."*

Three questions, each answerable page by page against `docs/reference/design-audit.md` (the site's
design rules and page inventory), and none of them needing the database:

- **Are the tools there?** For every page: what decision does the person on it have to make, and
  can they make it without leaving? The test is the owner's own workflow, not a feature list.
- **Is the information clean and clear?** One question per screen, the answer first, the number
  with its unit, the reason in a sentence a pharmacist reads, and nothing on the page that does not
  change what he does next. Folded detail rather than long lists; dashes where a figure is unknown,
  never a zero that means "not known".
- **Does it look and behave like a professional product?** Consistent layout, spacing, type and
  colour across every page; states for loading, empty, error and success; forms that say what they
  want and what went wrong; works on the phone he actually uses it from.

The owner again, 8 September: *"I really want this design edit to be done thoroughly and really
make the site look and operate well. Good plumbing, efficient, visually appealing, better use of
design elements like tables and charts when appropriate. Really make an effort to make sure viewer
can understand lots of info in a clear way in a small compact area."* So: density without clutter
— tables where rows compare, charts where a shape says more than a number, one screen answering
one question, and the plumbing behind it fast (no page reading the whole database on open; the
stores are held between requests and the page reads the store). This is a full pass over the page
inventory and needs no data, so it is **a fifth session, C, in the cloud**, working from
`docs/reference/design-audit.md` and `docs/ASSIGNMENTS.md` (Helper C), one section of the site per
pull request, screenshots of before and after in the description.

### 12. The secondary add-ons list has to make sense (8 September)

The owner: *"Let's also add an audit of the secondary supplier add-ons. This part of the site is to
give us things we could add on to an existing secondary supplier to hit the minimum. The things it
recommends from each supplier should make sense based on BOH, price, usage. The site will not know
what's already in order so it should list multiple options. We will use this list to find things we
could add on for that supplier to hit minimums."*

That is `/purchasing` — one card per non-primary wholesaler: "Order these" and "Next best to add,
soonest needed first" (`minimum-filler.ts`, `minimum-store.ts`, `shelf.ts buyListNow`). The audit
question is whether each recommended line is defensible on its three facts: **on hand** (from the
latest count — and no count has ever arrived, so today it runs on claims-derived usage alone and
must say so), **price** (the levelled, rebate-netted unit cost, this supplier against the best),
**usage** (units per day from the fills, over a window that is stated). A line the pharmacist would
not order — a slow mover with months on hand, a drug cheaper at the primary after rebate, a pack
larger than a season's use — is the failure. Multiple options, ranked, running total to the
minimum, never a single answer. Assigned to A (audit); session 1 supplies the live list and the
facts behind each of its top lines.

**Re-evaluated 8 September afternoon (1), at the owner's word** — "it lists very little options
for each supplier… I dont want to order things we dont use but we need options of things we can
add on to hit minimums." Measured first: every list empty; 442 of 545 dispensed drugs failed the
three-test `steady` bar on fifteen days of claims; a saving under $5 was dropped; an equal price
was dropped; and the planner's top-up took the whole days-of-stock cap (seven pods, $2,129, for a
$169 gap). Changed: an add-on needs only to be *used* (two days or two prescriptions in the
window; one fill is still refused), the cap on the observed rate bounds what it can cost; the same
price as the primary is an option; a top-up buys the packs the shortfall needs. After: IPC 0 → 11
options ($125.90 toward $200), IPD 0 → 3, the pod ×1. ANDA and ParMed still list nothing because
**no minimum is on file for either** — the owner's to give. McKesson's price in every comparison is
net of the ladder rebate at the band in force, and each basket prices its band cost.
### 13. The design pass is a fifth session (8 September)

See item 8. Session C: cloud, no data, owns `src/app/**` presentation and `src/components/**`
only — never a `*-store.ts`, never a pure module — and hands back one section per pull request.

### 9. Data health: complete, linked, and it says what is missing (7 September)

The owner: *"The logic and data in this site needs to be correct, full, and cleanly organized. If we
are missing data, I need to know and we need to fix it. Data needs to link when it should! This
system needs to be incredibly organized and complete from many ends or we will get bad numbers.
Main pieces are data from claims, data from supplier catalogs, data from third party sources
(NADAC, AWP, package sizes, equivalents) — all these things HAVE to be correct or what we are
building will not only fail but lead us astray."*

So the site gets one page that measures itself: **Data health**. For each dataset, how complete it
is, how current, and how many of its rows link where they must — counted on the real database,
with the gap named as an action. Tonight's answers by hand were exactly this kind of figure (NADAC
covers 96.9% of what we dispense; the FDA directory 96.9%; 0 of 1,081 claims match a contract; not
one McKesson invoice; no on-hand count ever). They should be on a screen, every day, not in a chat.

The links that must hold, each a row on that page with its coverage and its worst gaps:

| Link | Why it matters |
| --- | --- |
| claim NDC → FDA directory | equivalence; without it a product cannot be compared |
| claim NDC → NADAC (current within 3 months) | the benchmark every "over/under" figure uses |
| claim NDC → a catalogue row with a pack size | a per-unit cost; without it no margin |
| catalogue row → AWP | needed where a plan pays a discount off AWP (ParMed and IPD carry none) |
| claim → payer (BIN/PCN/group resolved) → plan class | who paid, and under what law |
| claim → contract (network id → contract) | the reimbursement formula |
| claim → 835 line → bank deposit | cash actually received |
| invoice → supplier register row → rebate ladder | what was really paid, after rebate |
| catalogue row → FDA package size | unit arithmetic that does not cross units |
| on-hand count → catalogue row | what is on the shelf, valued |

Each row: numerator, denominator, percent, the date it was last measured, and the top gaps in
words ("29 dispensed NDCs have no NADAC — 2 are devices, 27 are repackager labels"). Pure counting
in a module, a store that runs it, a page that shows it. **Assigned to session 2** after its invoice
follow-ups, because it runs on the pharmacy computer and can see the real database.

### 10. Plans have to be classified, or the law-first pricing never fires (8 September)

Data health's first run: **6 of 1,054 fills sit on a plan the register has classified.** The site
decides which law governs a fill — and so whether the Kansas floor (NADAC + the greater of $10.50
and the Medicaid fee) applies — from `plan_groups.classification`, which the owner sets per
BIN/PCN/group. With 99% unclassified, `drug-profit.ts`'s law-first rung is a rule with nothing to
act on. Two halves: the owner classifies the plans behind the most fills (the payers page; the Data
health row should name the top unclassified triples); and where the BIN listing states the line of
business (`payer_bins.linesOfBusiness`, Medicare Part D BINs are published), the site proposes the
class with its source and the owner confirms — proposed, never assumed. Assigned to A after the
contract match; owner action for the top plans now.

### 10b. The site holds three weeks of claims (8 September)

The paid claims archive runs from 24 August: a **15-day span** (Data health, "claims window").
Every rate the site computes — units a day, days on hand, steadiness, which NDC pays, the add-ons
list — is judged on it, and 449 of 553 dispensed NDCs fail the "dispensed on 3 separate days"
test for that reason alone. **Owner
action: load the claims history** — a PioneerRx "Rx Transaction Details" export covering the past
twelve months into the inbox, or the SQL read the owner is arranging. The reader already handles
the report; it only needs the months.

### 11. Pack sizes: fix every one we can, and a place to look up and correct the rest (8 September)

The owner: *"We need to fix correctly all the package sizes that we can. For those we can't, I need
a way to lookup and correct. These corrections need to stick."*

Data health measures 48,852 of 51,502 catalogue rows agreeing with the FDA's package (94.9%);
2,650 disagree, split between clean multiples (a catalogue counting inner packs — IPD's "30 EA" for
30 blisters of 6) and the rest. A pack size is a divisor under every per-unit cost, so each wrong
one is a drug that looks several times cheaper or dearer than it is. Three parts:

- **Fix automatically what the FDA settles.** Where the FDA's description reads cleanly to a
  dispensing unit and the catalogue's count is a whole multiple or fraction of it, the FDA's size
  is written as the correction, marked as the FDA's, with the arithmetic that justified it.
- **A page to look up and correct the rest** — every disagreement the FDA cannot settle (unit
  differs, description stops at a container, no FDA row), showing the FDA text, every supplier's
  pack size for the NDC, and the cost per unit under each reading, with one control to say which is
  right or type the truth. Searchable by NDC and name.
- **Corrections stick.** `ndc_pack_fixes` (per NDC) and `supplier_item_fixes` (per supplier and
  NDC) already exist for this and are laid over every import; the levelling reads the pharmacy's
  answer first, then the FDA's, then the wholesaler's. A correction records who, when and why.

Assigned to session 2.

### 14. Audit the P&P manual: compliant, and true to what the site actually does (8 September)

The owner: *"We need to audit P&P manual, make sure it is compliant and matches what we do in the
site."* The manual is one document, read and edited by chapter (`/manual`, its text in
`src/app/(app)/manual/page.tsx` and `manual_sections`), printed from the live copy, and every
procedure it promises has a form or a page somewhere in the site (`documents/manual` appendix A
lists them). Two audits in one, and a cloud helper can do both because the text is in the repo:

- **Compliant.** Chapter by chapter against what governs an independent pharmacy in Kansas: the
  Kansas Board of Pharmacy regulations (K.A.R. 68), K.S.A. 65-16xx, DEA 21 CFR 1300–1321 for
  controlled substances, HIPAA 45 CFR 164, OSHA bloodborne pathogens and hazard communication, and
  the immunization protocol statute (K.S.A. 65-1635a). Each finding names the section, the rule,
  what the manual says, what it must say, and a proposed sentence — never a rewrite the owner has
  not read. Inherited text that describes a chain (a Human Resources Manager, a Chief
  Administrator) is a known kind of finding.
- **True to the site.** Every procedure the manual describes must be the procedure the site
  performs: the training cadence and attestation, the CQI incident and summary path, the annual
  controlled substance inventory and Form C-250, the temperature log, the self-inspection, the
  document retention periods, the invoice and receipt records. Where the manual says one thing and
  the site does another, the finding says which should change, because the site is what the
  inspector will be shown running.

Assigned to **helper B after the inbox recogniser**, or to a sixth session if the owner wants it
sooner; session 1 answers questions of what the site does in practice from the real data.

### 15. The Add tool has to let the owner say what a document is (8 September)

The owner's words, uploading the balance-on-hand report: "no way to tell system that's what this
is in the add tool. need many more options!!!" The page offers a person and a credential type and
nothing else; every report goes through the recogniser's guess. Wanted: a "what is this" choice
listing every kind the site can read — Rx Transaction Details, Drug File Print (balance on hand,
with the count date asked for, because the report carries none), each wholesaler's invoice, a
supplier catalogue, an 835, a contract or provider manual, a bank statement, a staff document —
with "let the site work it out" as the default, and a named kind skipping the guess. **Assigned
to 2.** The report itself was filed by 1 by hand on 8 September: 1,770 items counted as of that
day, 36 lines without an NDC skipped, the first on-hand count the site has ever held.

### 16. The site has to be fast, and stay fast (8 September)

The owner's words: "site is still incredibly slow! we need to fix this and make sure it stays fast
and efficient." Measured 8 September at 12:10: free memory **765 MB of 7,105 MB**; the site
**1,300 MB** one hour after its restart; the two Claude sessions 930 MB; Chrome 660 MB; Defender
328 MB. Anything else that starts — a type check, a test run, a script that loads the catalogue —
pushes the machine into paging, and that is what "incredibly slow" is. Three causes and their
fixes: (1) `held.ts` never evicts and `refreshStale` recomputes every entry ever held on every
tick, including yesterday's books under yesterday's date key — fixed by 1 on 8 September (evict
what nobody has read for six hours; refresh only what was read in the last hour; cap the map);
(2) the heap ceiling in `launch.mjs` is not in force until the launcher itself restarts —
tonight; (3) Helper A's memory audit (`docs/audits/2026-09-08-memory.md`): `loadDrugDirectory`
peaks at 430 MB inside the web process and four readers pull 42 columns where they use nine —
the directory load moves to a script (2), the column lists are 1's. Rule for every session on this
machine, added to SESSION-RULES §1a: nothing that loads the catalogue or the directory runs in a
second process during pharmacy hours; measure with a query, not by importing the module.

### 17. The shelf screen has to show the drug, and everything a person needs beside it (8 September)

The owner's words: "the shelf screen needs to be better. not showing the drug name or any other
specifics that might be needed. need to audit this page and make better and more useful." Measured
on the first count (8 September, 1,770 rows): **every row is nameless** — the report's first column
is "Drug", which the reader's aliases did not include (fixed on 2's branch, ships with the reader
fix); **every row is costless** — the report's "Cost" column is not an alias either, so the page
says "the file carried no values"; "Order Point" and "Size" are dropped. And the page should not
depend on the file for any of it: 1,652 of the 1,770 NDCs are in the FDA directory (name, strength,
form, labeler, schedule) and 1,735 are in a supplier catalogue. The page itself is the surplus and
returns list titled "The shelf": it lists only lines beyond twice the target days. What is wanted:
the whole dispensing shelf, searchable — drug with strength and form, NDC, on hand in units and
packages, per day and days of stock, PioneerRx's order point against on hand, cost and value, the
cheapest supplier today, last dispensed, schedule — with the surplus section kept beneath it.
Reader aliases ("Cost", "Order Point", "Size") are 2's; the page and `shelf.ts` are 1's.
### 18. Pack sizes: where more than two suppliers carry an NDC, the majority settles it (8 September)

The owner's rule: "if more than 2 suppliers then go with majority agreement." Placed in the
levelling (`catalogue-cache.ts`, 1's) beneath the two documents: a pack the pharmacist typed wins,
then the FDA where a supplier already reads the box the FDA's way, then — for the NDCs neither
settles — the whole-package reading (count and unit) that more than half of three or more
suppliers share. Compared as readings, not strings, so "(2) 33.4 GM" and "66.8 GM" are one
vote. A tie or a two-supplier split still waits for the pharmacist on the pack-sizes page.

### 19. When the contracts are read: how many claims match a contract, and what would raise it (8 September)

The owner's ask: "once all contracts are done, want a breakdown of how many claims we can match
to contract and how we can improve it more." Deliver as a page section on Payers and contracts and
a HANDOFF paragraph: claims matched, by which route (network id, BIN, chain code, owner link), the
unmatched grouped by BIN/PCN with the fills and dollars behind each, and for every unmatched group
the one thing that would close it — a document not yet in the folder, a link the owner can make,
a plan class. Waits on the read finishing, which waits on the Settings → Claude ceiling.
### 20. Returns: the site has to tell the owner before a credit drops, and today it cannot (8 September)

The owner's question: "is our system setup to make sure I am returning things when I need to? if
we still have a bottle ordered from them we need to send it back before credit dips." Measured 8
September: the arithmetic exists (`returns-due.ts`: credit now, the day it drops and to what, the
day the window shuts, per invoice line against the supplier's own steps; surfaced on What to send
back, the shelf's surplus list and Money found on Today), **and it has one invoice to work on** —
IPC, 4 September, 8 lines. No ANDA, IPD, ParMed or McKesson invoice has ever been loaded, so no
bottle from them can be timed; and IPD and ParMed have no returns policy on file. Nothing pushes
a warning either: it waits on the page. Three pieces: (1) invoices from every wholesaler have to
arrive — each one's invoice email to the mailbox, a fixture per shape, 2's pipeline; (2) IPD's and
ParMed's policies, pasted by the owner as ANDA's was; (3) a warning that reaches him — a line in
the daily digest and on Today whenever a credit step drops within 7 days or a window shuts within
14, naming the bottle, the supplier and the dollars.
### 21. Return soon: one list of everything to send back, by policy, by idleness, by the dollars (8 September) — BUILT

The owner's words: "a return soon tool that shows everything the system thinks I should return
either based on return policy or non use, or expensive.. expensive things should have a much
quicker return time.. if not used we need to send back. cant have money sitting on shelf." Built
the same afternoon: `return-soon.ts` (pure ranking, tested) and `/purchasing/return-soon`, listed
under Buying. Three reasons in one list — a credit step or window from the supplier's policy on
the invoice line; nothing dispensed in the claims window; days of stock beyond what a line of
that value may hold ($1,000 or more: 7 days; $250: 14; less: 30). Soonest clock first, then the
dollars. Measured on the 8 September count: 1,200 lines, $137,606 sitting, 20 this week — and
every one without a supplier, because only IPC's one invoice is on file; and with 15 days of
claims "not moving" is a list to check, not to ship, and the page says so. Item 20's three
pieces are what make it real: every wholesaler's invoices, IPD's and ParMed's policies, and a
warning in the digest and on Today.
### 22. The add-on lists are only as right as the prices and equivalents under them (8 September)

The owner's words: "For this list we really need to make sure our equivalents and drug pricing per
supplier is correct or these recommendations will be wrong!" What holds today, from Data health on
8 September: 48,852 of 51,502 comparable catalogue rows agree with the FDA on the package; 630
rows are a whole multiple out (the expensive kind — a per-unit cost wrong by that factor) and
those are exactly what the pack-sizes page and the majority rule (item 18) work down; 485 of 486
dispensed NDCs carry a per-unit cost. The add-on rule compares the *same NDC* across suppliers,
so an equivalent under another NDC never enters it — safe, and narrow: a cheaper equivalent at a
secondary is never offered. Two pieces: (1) a pack-mismatch guard on the add-on list itself — a
line whose package the FDA and the wholesaler disagree on by a whole multiple is not offered until
settled, and the row says so; (2) add-ons by product (`equivalence_key`), offering the cheapest
equivalent NDC the pharmacy already dispenses under, never a brand for a generic or the reverse.
### 23. The chain: payer → BIN/PCN/group → plan class → network id → contract → rate → backtest (8 September)

The owner's framing, as ideas rather than statements: "Payor to bin to group to network id to
contract sounds like the whole game right?? This is what we need to do and correctly. This should be
organized this way also.. then we can backtest to see if correct.. especially on ERISA and part d
plans. Commercial plans will most likely be paying NADAC + 10.50?" It is the payer model in
`docs/reference/payer-model.md`, and the site holds every hop, unevenly. Measured 8 September:
BIN → payer: the claims report names the PBM on 1,302 of 1,304 paid claims and 36 payer links
came off contracts. BIN/PCN/group → plan class: 6 of 1,054 fills on a classified plan; item 10's
proposals wait on the owner's clicks. Network id → contract: 82 ids on 1,030 claims, 0 linked;
2 printed by a document, 52 ranked by their PBM, 28 with nothing to rank. Contract → rate: 65
rate lines in `network_rates` from 74 applied documents. Rate → price: `priceFromRate` exists and
prices nothing yet, because nothing is linked. **The backtest does not exist**: for every fill on
a linked contract, price it from the rate and set it beside what the plan actually remitted, by
plan class — Part D, Medicaid (the Kansas floor, NADAC plus the dispensing fee), commercial,
ERISA where a document says so — with the differences ranked by dollars. That is item 19 built as
a page, one hop per column, each hop's coverage as a fraction, and it is the shape the Payers
section should take. Owner's two ideas to test, not assume: ERISA plans priced apart from the
floor; commercial at NADAC plus $10.50. Order: link the top networks (one click each, biggest
first), finish the read (the ceiling), then the backtest on what is linked.

**Built 8 September, 15:02 (1):** no clicks where the paper decides. `deduceNetworkLinks` links a
network on its own when a document prints the id, or when its payer has exactly one document
written for this pharmacy's chain code; the reason is written on the link. Ran once: 14 networks,
305 claims (all nine Blue Cross networks to Prime's 2025 Limited Commercial exhibit — the only Prime
document read so far, so provisional until the rest are read; Capital Rx, MedOne, two Navitus).
Left: 47 networks with several documents written for us (590 claims: Optum 10, ESI 12, Caremark
9–10) — the PSAO listing or the backtest; 21 with nothing written for us (135 claims: Humana, Argus).
**8 September, 17:10 (1) — the last 21 claims, read off their own arithmetic.** With AWP and NADAC on
the rows (item 32), each open network's formula can be read from the claims: CNCKSNPN (Express
Scripts, BIN 003858, PCN A4 and MA, group 2ELA) paid **NADAC + $10.50** on every priced claim, basis
of reimbursement 20 (NADAC) — the Kansas Medicaid rate, so it is Sunflower Health Plan's KanCare
network under ESI; deduced and linked with the state's own fee as the document. Caremark's Part D
ids: MDR1S100S7 (retail, 30-day) and MDE1S100S7 (extended, 90-day) pay generics at MAC with a
$0.05 fee (basis 07) and the one brand at **AWP − 25.00% + $0.05** (basis 03); MDR0S02025 pays
Breztri at **AWP − 20.00% + $0.10** and its BIN 020115 / PCN IS rows carry Medicare contract H6316
with a $0.25 fee — all to be confirmed by the Medicare D guides when read, not linked yet. PAR001
(Caremark, PCN ADV, plan DTC_CMK_) is a **direct-to-consumer discount programme**: the patient pays
the whole discounted price, basis 6 (MAC), and the plan's "remit" is a −$5.00 programme fee —
marked a programme. The transaction report's basis-of-reimbursement code (NCPDP 522-FM: 03 AWP
less a percentage, 06/07 MAC, 20 NADAC) is what makes this reading safe; it is now on every row.

**8 September, 17:00 (1) — RXADV, from PioneerRx's own screen.** The owner sent the EDI response for
Rx 333913: Ventegra (BIN 012528, group VRX0071) returned Network Reimbursement ID (2F) RXADV with the
message "RXADV-AC: NOVO NORDISK HAS PROVIDED A $1027.03 VOUCHER TOWARDS THE PATIENT COPAY. ORIGINAL
COPAY: $1376. NEW COPAY: $348.97", after the plan rejected the drug (reject 70, plan exclusion). So
RXADV is the id a plan returns when an automatic manufacturer voucher was applied at the point of
sale — it rides on whichever plan adjudicated, which is why it sits under five payers — and the
"remit" on such a row is voucher money toward the copay, not a plan payment. Marked a programme;
Ventegra's BIN annotated on the register; the money belongs with item 24's reconciliation. The site's
row for 333913 was faithful to the report; the owner's memory that a voucher was involved was also
right; the report's "Amount" simply does not say which kind of money it is. That is the lesson for
item 30: a proof against the source file is necessary and not sufficient — the kind of money is a
fact the response carries and the transaction report does not.

**8 September, 16:00 (1) — the 148 open claims, and what the web says (hints, never links).**
Web findings carry a source and stay proposals until a document on file says the same. NET=400
(5 claims, $3,960) is the **CMS Medicare GLP-1 Bridge**, BIN 028918 / PCN MEDDGLP1BR, paid by CMS's
central processor at a fixed $50 copay through 31 December 2027 — CMS's own pharmacy document is
downloaded and filed in the library (cms.gov/files/document/glp-1-pharmacies-c.pdf). PHXCOM30 (3
claims) is the **Phoenix RxAdvantage discount card**, BIN 610268 / PCN PHXD (phoenixpbm.com savings
card) — the discount-card family, item 25. DODT5IND (24 claims, $1,959) is **TRICARE**: BIN 003858,
group DODA is TRICARE's own published BIN and group (tricare.mil FAQ); the rate is the TRICARE
retail network agreement with Express Scripts, not in the folder. FEHBP01001 (11 claims, $1,617):
BIN 610239 / PCN FEPRX is Caremark's Federal Employee Program routing (Caremark payer sheets), and
the guide prints a "Federal Employee Health Benefit Plan National" Caremark rate — the strongest
open proposal, one click or the backtest. Humana NET=0116/0111 (50 claims, $6,280): BIN 015581 /
PCN 03200000 is Humana Medicare Advantage (Humana payer sheets); no web page prints the network
id; the Humana Pharmacy Solutions manual and the pharmacy's own Humana agreement are the
documents. RXADV and CNCKSNPN (13 claims): nothing on the web.

Two follow-ups: run the deduction after every `applyAllReads`, and re-evaluate links the site made
when new documents arrive (today it skips anything already linked).
### 24. Copay-card remittance confirmations have to be read and reconciled to the claims (8 September)

The owner's words, uploading one: "this is remit confirmation for copay cards. we need to be
reconciling against the claims. we probably dont have these claims in our system but lets make
sure this process is set up and correct for future." The document: a scanned statement from
RedSail Technologies (RAS enrollment, Spartanburg SC) listing claims by prescription and fill with
the drug and the amount, totals ("Total Claims 177.25 … Total Amount Paid"), no text layer worth
reading. RedSail is BIN 028249 on the claims — 223 paid claims, the one BIN the PSAO listing does
not name — so these are the copay-assistance secondaries, and the confirmation is their remit.
Wanted: a reader on the intake path (the model read, since it is a scan; the same money guard the
invoice reader now has), one `claim_payments` row per line with source `copay_card`, matched to
the claim by prescription, fill and date the way the 835 reader matches, unmatched lines held and
named, and the statement's own total as the arithmetic gate. The sample is in the session's
uploads folder (`5171c9d9-Image_001.pdf`); a fixture with identifiers changed goes in `fixtures/`.
Assigned to 2 after the directory move; the recogniser side is B's.

**Reviewed 8 September, 16:45 (1), from the statement's own text layer (page 2 has one):** it is
RedSail's "Remittance Advice — RAS Copay Voucher Reimbursement": payment date, check/ACH number,
payment amount, NPI; rows of rx (twelve digits, zero-padded), date of service, NDC, drug, qty,
submitted, patient paid, voucher paid, with reversals as the same row negated; footer Total Claims,
Total Fee, Balance Forward, Total Amount Paid. The rows net to the printed total to the cent
($177.25 = 321762 $174.31 + 330204 $2.94; five other prescriptions paid and reversed) — the
arithmetic gate. The claims it settles adjudicate on BIN 028249 / PCN RXLOCAL (308 on file); the
claim's remit is what the voucher promised, so a line settles it (revenue 0) and a difference is
flagged. Spec sent to 2 in full on 8 September; these lines are August fills, before the claims
on file begin, and match once the twelve-month export lands.

### 25. The PSAO's discount card and copay networks guide (8 September)

Uploaded as `898d0c4f-2026hmadiscountcardandcopaynetworks_1.xlsx`: a different shape from the
networks guide — a rate tab per discount card programme (BIN, PCN, group, rates by days supply),
a "Discount Card Listing" of BIN/PCN/group per card, and drug lists (Apollo Care NDCs by
manufacturer, ConnectiveRx programmes, Visory specialty). Read it the way the networks guide is
read (`psao-guide.ts`), one document per programme, with the BIN/PCN/group as the rate's routing;
the drug lists are what says a claim on those BINs is a copay-card claim rather than a plan's.
### 26. When the PSAO's guides roll to a new year, the site has to ask for the new ones (8 September)

The owner's words: "also need a way ie 2027 for when they change to alert me to get new list." The
guides are dated documents in the library now — the 2025 networks guide (42 documents), the 2026
PBM listing, the 2026 and 2027 Medicare D guides. Rule: from 15 November of a guide's year, and
again each month, if no guide for the coming year is on file for that family (networks, PBM
listing, Medicare D, discount card), a line on Today and in the weekly email says which guide is
missing and where it comes from (Atlas, pbmrelations.hmatlas@mckesson.com). And when a newer guide
is loaded, the older year's rate lines are marked superseded from the newer one's effective date,
never deleted: last year's claims still price on last year's guide. Lives with the contract clocks
(`contractClocksDue`).

### 27. Remittance advices (835s) emailed to the site have to be recognised and applied (8 September)

The owner's words: "dont forget about remittance advice. going to have those emailed into site as
well, system needs to know how to correctly handle them." Today an 835 is handled only when
dropped through the Add tool (`intake/actions.ts` → `importRemittance`); the mailbox sweep
(`autoroute.ts`, `mailbox.ts`) does not recognise one, whatever its extension. Wanted: recognise an
835 by its content — an ISA envelope with ST*835 — under any name (.835, .edi, .txt, .dat, or a
zip holding one), route it to `importRemittance` with the same balance check the reader already
enforces (refuse a file whose CLP, PLB and BPR do not balance), post the payments onto the claims
by prescription and fill, and file the payer's 835 as the receipt the cash books read. Unmatched
lines are held and named, never dropped. Recogniser side B's; route and post 2's; the reader is
A's and already tested. The facilitator's files already arrive this way through the MTF tool.
### 28. From contracts to profit: prove the rate, then change what is bought and dispensed, on one page (8 September)

The owner's words: "we have contract info and can make a lot of connections. how do we use that to
extract more profit, change what we order. whats best way to do this.. are we sure about
reimbursement rate, can we prove it? how do we turn that into more profit.. how do we present that
info to me in a clear way to make it actionable??" And, the same hour: "a little concerned your
info doesnt match reality." The order is fixed by that concern. (1) **Prove it** — the backtest of
item 23: every fill on a settled network priced from its rate and set beside what the plan paid,
by network, with the share that reproduces within a dollar; nothing downstream is trusted from a
network the backtest has not proved. (2) **Then use it**, three levers each measured on the real
fills: which NDC to dispense within an equivalence group under each network's formula (a MAC or
AWP-minus rate pays the same for a dearer NDC, so the cheapest to buy wins; a NADAC-plus rate pays
cost plus a fee, so the choice is indifferent); which wholesaler to buy each from given that; and
where a days-supply band (84+) or a preferred network pays differently. (3) **Present it** on one
page, Profit by payer: per network — fills, revenue, cost, margin, expected against paid, the top
drugs losing money and the one action each — with the proof share printed beside every figure.
### 29. Which NDC nets the most for a drug: an aggregate over the drug's claims, and only the exceptions (8 September)

The owner's design, in his words: "I cant necessarily tailor my ordering to one claim, this is why
we will have to look at aggregate of claims for 1 drug and find which NDC nets the most for that
drug based on reimbursement (contracts) we do for that drug and what we purchase at.. this will be
a fluid calculation.. and really our system is set to order cheapest net drug, so system should be
looking for cases where that isnt true and let me know. will take multiple months to get enough
data to be confident." So, per drug (equivalence group), not per claim: take every fill of that
drug in the window, the network each fill priced under and that network's formula (proved by the
item 23 backtest, never assumed), and for each candidate NDC the pharmacy could buy compute what
those same fills would have paid under each formula (AWP-minus pays more for a higher-AWP NDC; MAC
and NADAC-plus pay the same or by that NDC's own benchmark) less what the NDC costs to buy today,
net of rebate — a net per unit for the drug's actual payer mix. The buy list already orders the
cheapest net-cost NDC; this reports only the exceptions: drugs where a dearer-to-buy NDC nets more
across the mix, with the dollars a month, the fills behind it, and a confidence that grows with
the months of claims (thin until the twelve-month export lands). A very high-dollar item may be
judged per claim; everything else in aggregate. `drug-profit.ts` is the start of it. Depends on
23 (proved rates), the catalogue's AWP and NADAC per NDC, and the equivalence keys.
### 30. Proof rows: every dataset re-proved against its own source file, every night (8 September) — the most important thing

The owner's words: "these things need to be right!! we need to make sure claims are matching
their info properly and continue to. we need to do the same with drug info (pricing, nadac, awp,
equivalents, etc).. this is the most important thing." SESSION-RULES §1c is the rule. What holds
today: the claims reader checks three totals against the report at import and refused nothing
wrongly (the 4 September rows re-read from the stored file matched field for field); Data health
measures completeness and linkage on twenty rows. What is missing is the nightly re-proof from
the stored files. Build, in this order: **claims** — every stored report file re-read each night,
rows and the report's own totals set against the claims table per day, any row that differs
named; **catalogues** — each supplier's last file's row count and price sums against the stored
rows; **NADAC** — the CMS file's rows and as-of date against the table; **FDA directory** — the
zip's product and package counts against the table, and the equivalence keys re-derived; **on-hand**
— the report's own count against stored (2 built the gate); **invoices** — total against lines;
**remittances** — the 835's CLP and PLB against the payments posted; **the guides** — the
workbook's rows against the documents. Each a Data health row with the file's date, each
disagreement a red row on Today. Data health is 2's: the rows and the nightly script; the claims
re-read is 1's. Ahead of item 24 in 2's order, by the owner's word.
### 31. The site starts clean on 1 September 2026: no history is coming (8 September)

The owner's words: "i will not be uploading claims from before sept.. or anything. this site is
starting clean as of 09/01/.." So the twelve-month claims export is withdrawn from every list that
waited on it (10b, 23, 24, 29, the HANDOFF owner list), and the site needs a stated start date:
a `site_start_on` setting, 2026-09-01, read wherever the site judges a window. Consequences to
build, small: the 23 facilitator payments and the RedSail statement's August lines are for fills
before the start and will never match a claim — they are shown as "before the site's start" and
counted in cash as received, not as unmatched; the facilitator page, the remits Data health row
and the copay-card reconciliation say so in those words. Every rate, steadiness and idleness
judgment carries the window it was made on, and the window grows from 1 September: the
"short window" caveats on Return soon, the add-on lists and item 29 stand until the months
accrue, and the pages print the number of days held. The claims of 24–31 August already on file
stay (they are real and proved) but are outside the start.
### 32. PioneerRx's dispensed export is the second claims feed: it enriches, it never duplicates (8 September)

The owner uploaded `daily_0901_to_0907.xlsx` — "this is the correct info" — one row per
prescription sold, 51 columns, with what the transaction report never prints: AWP, WAC and NADAC
for the dispensed quantity, DAW, days supply, dispensing fee, basis of reimbursement, the plan's
own contract id, DIR fee, e-voucher, the sold date, and the secondary payer beside the primary.
Compared row for row the same day: 916 of 943 prescriptions in both agreed on the remit to the
cent; every difference had a reason (the export prints the primary's copay, the transaction
report what was left after a secondary paid; a $0 primary here is the paying secondary there).
Built the same hour: `dispensed-export.ts` — pure parse, tested; `enrichClaimsFromDispensedExport`
writes the export's columns onto the claims the transaction report proved, keyed by prescription,
fill and BIN, and names what it cannot place (303 rows on the first file: fills processed before
the site's records, per item 31). Migration 0091. First run: 940 primaries and 28 secondaries
enriched; September's paid claims now carry AWP on 957, days supply on 1,035, NADAC on 914, the
sold date on 952. Left to do: the export as a daily feed through the mailbox and the Add tool
(its own kind; 2 and B), a nightly proof row that re-reads the stored file against the enriched
columns (item 30), and the transaction report's `Rx Transaction Details` stays the source of the
claim itself — the export enriches, it never creates.
### 33. The 835 reader has no arithmetic gate: lines are stored without being checked against the remittance's own total (8 September)

Found by 2 while writing the manual's payments section, then withdrawn from the manual because it was not true
of the code: `claim-payments.ts` stores every payment line an 835 carries and never adds them up against the
remittance's printed total (the BPR amount, and per-claim CLP totals against their SVC lines). The invoice
reader refuses a document that does not add up, on the argument that a partial read is the dangerous outcome
rather than the failed one: every figure that was read looks sound, and only the dropped line's dispensing
appears to have been paid less than it was. The same argument applies exactly here (SESSION-RULES §1c, and the
rule that every reader that decides money is checked by arithmetic before anything is stored). What to build:
sum the CLP payment amounts and compare to BPR02; sum each claim's SVC paid amounts plus adjustments to its CLP04;
a remittance that fails either is held whole, shown on Remits with the two figures, and nothing from it is
matched until it is read again or the owner accepts the difference by name. The facilitator's 835s and RedSail's
copay remits (item 24) go through the same gate. 1 builds it after the PioneerRx feeds (item 6).

## The data the site has to ingest

Named by the owner on 7 September as what is still being connected. Each one needs a reader, a
place, and an arithmetic check before anything is stored.

| Feed | Cadence | State |
| --- | --- | --- |
| Rx claims | daily | ingesting |
| Supplier invoices | daily | ingesting |
| NADAC | weekly | ingesting, coverage measured 7 Sep |
| MTF / facilitator payments | as they arrive | page exists (`/remits/mtf`) |
| On-hand counts | weekly | **owner asked 7 September: "Did we receive a balance on hand report yet? Didn't come in right?"** — checked on the live database that night; see Done/HANDOFF for the answer |
| Supplier catalogues with pricing | nightly from PioneerRx | ingesting, 5 suppliers — **but on 7 September only ANDA and ParMed arrived; McKesson, IPC and IPD did not.** Owner action: check PioneerRx's scheduled deliveries for those three. Data health gains a per-supplier "last file" row so the site says this itself. |
| Other expense invoices | as they arrive | ingesting |
| Third-party reimbursement contracts | as signed | reader built, first live runs done |
| **835 remittance files** | **future** | **none received yet**; the request builder is live (B), the remittance tables are designed (`payer-model.md`, A auditing) |
| **Bank statement** | monthly | **never uploaded** — the owner's action at month end; the reader (`bank-statement.ts`) and the placement (`money/bank.ts`) exist; the deposit-to-remittance reconciliation is 2's next build |

## Done

- **McKesson's rebate reaches prices (7 September, deployed as `e471895`).** All three ladders were
  stored without the ratio that drives them, so no band was ever chosen and 7,165 contract generics
  were compared at printed price. Migration `0084`; verified live at 29% off contract items and
  0.75% off brand. HANDOFF item 2, the six buying-logic fixes, measured in the same pass.
- **Invoice lines belong to the supplier the invoice named (session 2, merged in `29f953b`).**
  `invoice_lines.supplier_id` carried from the invoice, `suppliers.aliases` typed by the pharmacy,
  equality matching only, unplaced lines counted and named on every supplier card. IPC's two
  invoice spellings typed as aliases.
- **The site deploys itself from the pharmacy computer (7 September, 9:34 PM).** `npm run deploy`
  pushes `feature/compliance` and has the launcher rebuild, migrate and restart, and waits until
  the app answers on the new build. "Let Claude run the site.cmd" was run once: the machine-local
  permissions are in, the session starts at sign-in with `--continue` and Remote Control, and
  migrations are at 83. Verified on the live database after the restart: zero placeholder rows in
  either table. Nobody needs to walk to that computer for the site.
- **Product identity comes from the FDA directory** (commit `1c8591d`, live since 9:34 PM):
  96.9% of dispensed NDCs placed by `equivalence_key`; the 10,427-NDC cross-form merge is gone.
- **The nine reserved placeholder rows** ("TBD DO NOT DELETE OR RELEASE") are refused by both
  catalogue importers and cleared by migration `0082`. They were McKesson rows priced at $110.25 a
  unit on NDCs nobody can order, flagged "not rebated" — the flag the buy list reads as a reason to
  source elsewhere. The refusal written on 8 September guarded the NADAC path, where they had never
  been.
- **NADAC coverage is measured and the site is not blind** — see item 1 above and `docs/HANDOFF.md`.
