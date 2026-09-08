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
- **The supplier's own item number, per supplier.** The column exists (`supplier_items.item_number`,
  migration 0078) and both importers read it. It fills in on the next catalogue import; until then
  rows show a dash. **Needs confirming after the next import that it is actually populated**, per
  supplier, and not just present as a column.

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

### 3. Re-measure the six buying-logic fixes against real data (HANDOFF item 2)

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
- **Cash and accrual both, and the difference explained.** The split exists but is on the audit list
  as unexamined (item 5). A cash change has no accrual side and must print as a dash rather than a
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

## The data the site has to ingest

Named by the owner on 7 September as what is still being connected. Each one needs a reader, a
place, and an arithmetic check before anything is stored.

| Feed | Cadence | State |
| --- | --- | --- |
| Rx claims | daily | ingesting |
| Supplier invoices | daily | ingesting |
| NADAC | weekly | ingesting, coverage measured 7 Sep |
| MTF / facilitator payments | as they arrive | page exists (`/remits/mtf`) |
| On-hand counts | weekly | ingesting |
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
