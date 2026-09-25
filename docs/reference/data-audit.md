# Data audit: how the information is organised, and what else it can earn

September 2026, on `feature/compliance` at `2e02e97` plus the cloud branch. Every claim below
names the file it was read from. Fixes are ordered by consequence; uses by value against readiness.

## 1. What comes in, and where it lands

Recognition is by content, never by file name (`autoroute.ts` `classify`), and every message and
attachment is de-duplicated on its id (`mailbox.ts`). That part is right and should stay so.

| Feed | How it arrives | Read by | Lands in | Keyed on |
|---|---|---|---|---|
| Daily transaction report | email, 6:30 pm | rule (`rx-transactions.ts`) | `claims` (source `transaction_report`) | `transaction_key`; reversals by `reversal_key` |
| Supplier catalogues (Mon) | email, one file per supplier | rule (`pioneer-catalog.ts`) | `supplier_imports`, `supplier_items` | (supplier, ndc11), **replaced each week** |
| Supplier invoices | email PDF | rule; model only where the rule read nothing, both checked to the printed total (`invoices.ts`, `invoice-lines.ts`) | `documents`, `supplier_invoices`, `invoice_lines` | `document_id` |
| McKesson rebate breakdown | email PDF, monthly | rule, seven self-checks (`rebate-report.ts`) | `supplier_rebate_programs` + `suppliers.rebate_statement_json` + two settings | latest write wins |
| Purchase Drill Down | email PDF, daily | **model**, no arithmetic check (`ai.ts` `readPurchaseDrillDown`) | one setting, `rebate_ratio_latest` | newest `generatedOn` wins |
| Return policies | email PDF | model, held as a draft until confirmed | `supplier_return_policies` | versioned rows |
| NADAC | data.medicaid.gov weekly + email | rule | `nadac_prices` | unique (ndc11, effective_on) |
| 835 remittances | MTF CLI download folder | rule (`x12-835.ts`) | `claim_payments` | matched on the fill (rx, fill, date, NDC) |
| Payer references | CSVs in `data/reference/` | rule | `payer_bins`, `network_rates`, `mac_appeal_terms`, `payment_routing`, `pbm_contacts` | none: truncate and reload |
| Contracts | folder of PDFs | model, batch, stored as JSON drafts | `contract_docs.extraction_json` | document |

How they tie: supplier by `suppliers.id` (with `catalog_name` and `sender_emails` as the two
joins to the outside world); product by `ndc11` and, across manufacturers, `product-key.ts`;
payer by BIN + group (`plan_groups`) and the more specific `payer_links`; prescription by
rx + fill + date + NDC (`fills.ts`, which folds a fill billed to two payers back into one bottle);
money by that same fill key (`claim-payments.ts`).

## 2. What is well organised

- Every reader that decides money is checked by arithmetic before anything is stored: invoice
  lines must multiply out and add to the printed total; the rebate ladder must reproduce the
  statement's own rate and rebate; a claim's ingredient cost is the NCPDP identity, not a guess.
- One fill, however many payers priced it. Without `fills.ts` a coordinated claim doubles its
  cost and halves its revenue; the first live day was $459 wrong for exactly that reason.
- The document behind every figure is kept (`supplier-documents.ts`), so a rebate band or a
  return window can be argued with the supplier from the page it was read off.
- Nothing is inferred where a document could say it: no rate borrowed from another supplier, no
  ratio recomputed past the scrub, no plan classified by software.

## 3. What to fix, in order of consequence

1. **Catalogue price history is thrown away every Monday.** `suppliers.ts` deletes each
   supplier's rows for the NDCs a new file covers and inserts the new prices. A year of weekly
   files from four wholesalers is a price history for forty thousand NDCs, and the site keeps one
   week of it. Fix: append every import's rows to a `supplier_price_history` table
   (supplier_id, ndc11, priced_on, unit micros, pack, contract flag, import id); keep
   `supplier_items` as "current". Unlocks §4 items 3 and 9.
2. **The drill-down is the one model read that selects money and is not checked.** Its figure
   lands in a settings key as JSON, months included, and `rebate-rates.ts` lets it pick the band
   over the statement. Fix: a `purchase_positions` table (one row per report per month, every
   money column the report prints); `drill-down.ts` `checkMonth` after the read, refusing a row
   whose money does not reproduce its ratios; the statement's scrubbed figure selects the band
   until the scheduled report carries McKesson's own exclusions (`buying-logic.md`, Rule 3).
3. **The rebate settlement is stored three ways** (`suppliers.rebate_statement_json`,
   `mck_rebate_last_statement`, `mck_generic_rebate_rate`), latest write wins, and only the
   current month survives. Fix: `rebate_statements`, one row per period per supplier, from which
   `rebate_statement_json` and both settings are derived. Unlocks the rebate trend and the
   contract replay.
4. **Supplier is keyed two ways.** `supplier_invoices`, `supplier_imports`, `supplier_items`
   carry a nullable `supplier_id` with no foreign key and a free-text `supplier` name beside it;
   `invoice_lines` copies the parent invoice's supplier and date. Fix: backfill `supplier_id`
   from `catalog_name` / `sender_emails`, make it the join everywhere, keep the name for display.
5. **Payer identity lives in three places with two keyings**: `claims.pbm_name` (a copy),
   `payer_links` (bin + pcn + group + contract), `plan_groups` (bin + group). Fix: `plan_groups`
   is the plan; links resolve to it; `pbm_name` on a claim is derived, never stored.
6. **Product key is materialised only on `supplier_items`.** Claims and invoice lines are
   re-keyed on every page load. Fix: store `product_key` on `claims` and `invoice_lines` at
   import, from NADAC's description where the NDC has one (`product-groups.ts` now delegates to
   `product-key.ts`; it was a duplicate until this audit).
7. **Ten settings keys carry data, not configuration**: the drill-down position, the rebate
   statement and rate, a whole parsed return policy, practice decisions, dataset ids, job state,
   and two that duplicate columns on `suppliers` (`supplier_expected_schedule`,
   `mail_supplier_rules`). Each is a row in a table somebody will one day want the history of.
8. **An invoice is de-duplicated only by its document id.** A PDF re-sent under a new message id
   files twice and doubles that week's purchases in the ledger. Fix: unique on
   (supplier_id, invoice number, invoice date).
9. **Cash sales are invisible.** Every PharmD Loyalty row (BIN 028249) is skipped at import, so
   the cash price the pharmacy sets is never compared with its cost or with NADAC + fee.
10. **Orphans**: `ce_entries` is read and written by nothing; `gs1.ts` parses lot and expiry off
    a barcode and nothing calls it; `mac_appeal_terms`, `payment_routing`, `pbm_communications`
    are loaded and shown but no analysis joins them.

Two feeds send less than they could, and only the report writer in PioneerRx can fix them: the
claims export leaves Dispensed Quantity and Acquisition Cost empty (`report-check.ts`), and no
report carries the basis of reimbursement (NCPDP 522-FM), so the plan's pricing basis is inferred
from its payments (`pay-basis.ts`) instead of read.

## 4. What else the data can earn, by value against readiness

**Ready with what is held today**

1. **The buy list, the NDC choice, and the band beside every order line.** Built on the cloud
   branch (`under-nadac.ts`, `ndc-choice.ts`, `ratio-effect.ts`), tested, not wired. Wiring them
   to the purchasing page and an order sheet is the single largest step left: it turns "what am
   I paying" into "what to order today, from whom, and what it does to the rebate".
2. **MAC appeals with the invoice as evidence.** `against-nadac.ts` already separates "owed"
   from "argue". `invoice_lines` now holds the actual acquisition cost per NDC per date, which is
   the one document a MAC appeal needs, and `mac_appeal_terms` holds each PBM's window and
   portal. Join the three and the site produces the appeal packet (fill, paid, MAC, invoice line,
   deadline) the day the claim comes in. This is money the pharmacy is owed today.
3. **Price-change alerts** once history is kept (§3.1). A catalogue price rising on a product
   dispensed daily is a reason to buy a month ahead; a NADAC falling below the pharmacy's cost is
   a reason to change NDC or supplier before the next fill is paid at the new figure. Both are
   one query a week over data already arriving.
4. **Returns to stock as a number.** With the transaction feed now keeping every row, a claim
   transmitted and reversed without a sale is a bottle filled, labelled and put back. Count them
   by drug, by plan, by day of week, and the will-call procedure has a figure to be judged by.
5. **Brand steering against the ratio.** `ratio-effect.ts` says how much brand can go through
   McKesson before the band is lost, and what one band is worth on the month's OneStop base. A
   monthly "move these brands to the secondary, keep these" list follows directly from the
   drill-down and the catalogues.
6. **Cash pricing.** Import the 028249 rows as cash sales (§3.9). Cash price against effective
   cost and against NADAC + fee, by product: where the cash price is below what Medicaid would
   pay, it is a price to raise; where it is far above, a discount card is taking the fill.
7. **Rejects by payer.** The daily report's R rows are counted and dropped. Kept by payer and
   product they are the rework cost per plan, and the first thing to ask PioneerRx to add a
   reject code to.
8. **Payer performance to network decisions.** `payer-map.ts` already ranks payers by margin per
   fill. Add the SB 20 recoveries and the appeal outcomes above and it becomes the case for
   leaving a network or renegotiating one, with the dollars per year on the page.

**Needs one more feed**

9. **Contract replay** (PLAN §4.5): twelve months of `invoice_lines` through each wholesaler's
   terms. The lines are accumulating from now; the first replay is a year out unless the McKesson
   Connect invoice export is requested to backfill it.
10. **Days of supply and over-buying**: purchases less dispensing per product, from
    `invoice_lines` and `claims`, gives a relative figure today and a true one once an on-hand
    report is scheduled out of PioneerRx. With on-hand and expiry, `returns-due.ts` prices
    what is on the shelf rather than what was invoiced, and `gs1.ts` can read expiry off a
    barcode at receiving.
11. **Commercial 835s.** Only the MTF folder is swept. The PSAO or clearinghouse 835s for
    commercial plans would let the site compare what was adjudicated with what was actually paid,
    per claim, which is where DIR and short-pays hide.
12. **Basis of reimbursement on the claim** (522-FM) replaces the inference in `pay-basis.ts`
    with the plan's own statement, if PioneerRx will add the column.

## 5. The order to do it in

First §3.1, §3.2 and §4.1 together: they share the purchasing page and the same week of work,
and they are the difference between a site that reports and a site that orders. Then §4.2, the
appeals, because it is owed money with its evidence already on file. Then §3.3 through §3.6,
which are structural and get harder the longer they wait. Everything in §4.9 onwards waits on a
report or a feed the owner has to request.
