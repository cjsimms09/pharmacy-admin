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
- **The supplier's own item number, per supplier.** Measured 8 September after the nightly
  imports: ANDA, ParMed, IPD and IPC **100%**; **McKesson 0 of 44,242**. The McKesson file carries
  the column ("Supplier Item Number" is its first field) but its rows wrap onto two lines and the
  PioneerRx parser is not picking the number up for that layout. Session 1, `pioneer-catalog.ts`,
  with a McKesson-shaped fixture.
- **Pack sizes, against the FDA (8 September).** The levelled catalogue agrees with the FDA
  package on about 95% of rows at every supplier. The rest: 0.5–1% where the FDA is a whole
  multiple of the catalogue (IPD "30 EA" for 30 blister packs of 6 = 180, a sixfold unit-cost
  error), 2.5% where the unit differs (GM against EA), 1.5% other — and many of those are the
  FDA *reading* being wrong, because `packageUnits` takes the outer count ("3 BLISTER PACK") and
  ignores the inner ("28 TABLET in 1 BLISTER PACK"). The parser has to read the nested description
  to the innermost unit. Assigned to session 2 as the Data health row it belongs to.
- **AWP where a supplier prints none (8 September).** ParMed and IPD print no AWP; 7,551 NDCs
  have no AWP on one supplier's row and a printed AWP on another's. AWP is a property of the
  NDC, not the seller, so the levelled catalogue should carry the newest printed AWP for the NDC
  onto every row, marked as borrowed. Session 1, `catalogue-cache.ts`.

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

**Deliverable, session 1 after ingestion, audited by A:** `docs/reference/payer-model.md` defining
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
not a reason to lose the counterparty, the networks and every contact on the document. Change the
rule to drop the uncited value and keep the read, with the drop recorded in `unclearOrMissing`.
And the read stops when the API key's monthly spending limit is reached (8 September, at 177 of
325) — the limit lives in the owner's Anthropic console, not in the site; the site's own ceiling
(`ai_monthly_cap`, $50) never saw it because contract runs are not counted into `spend()`.
Fix that accounting too, so the site's ceiling means what it says.

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

This is a full pass over the page inventory and belongs to a cloud session, because it needs no
data — it needs eyes and the design rules. Not yet assigned: A and B are on the money chain,
which the owner ordered first. Assign when one frees, or to a fifth session.

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
| Supplier catalogues with pricing | weekly | ingesting, 5 suppliers |
| Other expense invoices | as they arrive | ingesting |
| Third-party reimbursement contracts | as signed | reader built, first live runs done |
| **835 remittance files** | **future** | **not started — remits tracked per claim** |

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
