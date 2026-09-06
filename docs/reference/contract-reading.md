# Reading the contracts: what to get, why, and where it goes

The contracts sit in a folder on the pharmacy computer (`data/contracts`, never in git). The site
already indexes them for search, sends each through Claude's Batch API with a fixed schema and
system prompt, and keeps the result as a draft beside the document. What was missing was the
specification: exactly what has to come out of each document for the site to categorise every
payer, price every claim, match claims to the contract that governs them, send an appeal, and
re-route the 835. This is that specification. Nothing is read until it is agreed.

## 1. The categories, and the one line that ties them together

A claim carries a BIN, a PCN and a group number. A contract is written by a **counterparty** (the
plan sponsor or PSAO), adjudicated by a **PBM vendor** (the processor named on the rate line, which
may differ from the counterparty), for a **line of business** (Commercial, Medicare Part D,
Medicaid, FEHB), on a **network** (Preferred, Standard, Value), for a **cost-sharing tier** and a
**days-supply band**, and only for pharmacies whose **chain code** the exhibit lists. Documents sit
in a **chain**: base agreement, amendments, exhibits, rate sheets, each superseding what it names.

So a payer is categorised on six axes, all of them read from the document, none inferred:

| Axis | Read from | Stored in |
|---|---|---|
| Counterparty | the document's own naming | `contract_docs.pbm_name` |
| PBM vendor | each rate line | `network_rates.pbm_name` |
| Line of business | the exhibit heading | `network_rates.line_of_business` |
| Network and cost-sharing tier | the rate table's axes | `network_rates.network` |
| Days-supply band | the rate table's axes | `network_rates.days_supply` |
| Identifiers: BIN, PCN, group, chain code | printed inside the exhibit | `payer_links` (after a person confirms) |

The one line that ties a claim to all of this is the **payer link**: BIN, PCN and group on the
claim to the PBM vendor and the document. It is proposed by the site and confirmed by a person,
because a BIN printed in two exhibits is a decision, not a fact.

## 2. What is extracted from every document

The schema is `src/lib/contract-terms.ts` (`ContractTerms`), the prompt is `EXTRACT_SYSTEM`. Every
figure that decides money carries the contract's own sentence and where it was found
(`requireCitations` refuses to store one without). The fields, grouped by what they are for:

**Identity and chain.** Counterparty, title, type (payer network / wholesaler / PSAO), role in the
chain (base, amendment, exhibit, rate sheet, manual, notice), parent agreement, what it supersedes,
what it incorporates by reference and where definitions live. *Why:* a rate sheet without its base
agreement is half an answer; last year's exhibit applied to this year's claim is a wrong appeal.

**Identifiers.** BINs, PCNs, group IDs, chain codes, network names, lines of business. *Why:* this
is how a claim finds its contract (§4).

**Dates with clocks.** Effective and end dates, auto-renewal, termination and amendment notice
days. *Why:* a notice window missed is a rate accepted.

**Money.** One rate line per vendor × network × tier × days-supply band, each with the brand
formula, the generic basis and both dispensing fees copied as written; effective-rate guarantees
kept apart (they are aggregates, not claim prices); post-point-of-sale discounts (DIR by any name)
with how they are collected; dispute windows; reports owed. *Why:* §3.

**Appeals.** Window in days and what starts it (fill, adjudication, remittance), the method, the
submission target (portal, address, fax), the required fields, whether the invoice is required, the
response time, whether an adjustment is retroactive. *Why:* §5.

**People.** Every contact the document names, by purpose: MAC appeals, provider relations,
payment/EFT, audit, notices, credentialing. *Why:* §5 and §6.

**Payment path.** Who pays, by what method, on what cycle, whether an 835 is offered, how
EFT/ERA enrollment is changed, whom to ask. *Why:* §6.

**What moves the money after the formula.** The pricing compendium and its date basis (which
AWP, as of when); where the MAC list is published and how often it changes; every performance
measure with its threshold and its effect on DIR, bonus or penalty; DAW and brand penalties;
days to pay a clean claim and interest when late; recoupment and offset rights with the notice
owed. *Why:* two "AWP-15%" contracts pay differently on the compendium alone; the MAC list is
the first line of an appeal; the measures are what DIR is actually driven by.

**Honesty.** What could not be read, and a confidence.

## 3. Reimbursement: from the sentence to a figure

`src/lib/rate-formula.ts` reads the sentence ("AWP-15% + $1.00", "Lesser of (MAC or AWP-25%) +
$1.00", "NADAC + $10.50") into legs, a lesser-of flag and a fee, and prices a claim on the
benchmarks the pharmacy holds. Rules:

- A benchmark the pharmacy does not hold is never guessed. AWP comes only from McKesson's invoice
  lines today; the owner's item to schedule a PioneerRx item report with AWP and to add "Dispensed
  AWP" to the daily report is what makes AWP-based formulas priceable on every claim.
- A lesser-of with the MAC not held prices on the other leg and is marked **at most**: the figure
  is the most the contract owes, and the appeal that follows is the one a MAC appeal actually is
  (is the MAC below acquisition cost?).
- A sentence the parser cannot read stays as words on the review checklist, never as a price.
- The observed formula (`reimbursement-fit.ts`, back-calculated from the claims) is shown beside
  the stated one. Where they disagree, that is the first thing to appeal or to ask about.

## 4. Matching claims to the contract that governs them

`src/lib/contract-apply.ts` `proposeFromContract()` takes the draft and the plan register (every
BIN/PCN/group the pharmacy has billed, with claim counts) and proposes links:

1. A plan matches on **BIN and PCN** together first, then **BIN alone**; a **group alone is never a
   match** (group numbers repeat across PBMs).
2. A BIN printed in more than one document is **contested** and named; the person picks, usually
   by PCN, chain code or effective date.
3. The proposed link is the most specific one that still matches the plan (`matchScore`), so the
   row naming BIN and PCN beats the row naming the BIN.
4. Confirmed links go to `payer_links` and are applied to the claims (`applyLinksToClaims`), which
   is what puts a contract id on every claim the site prices.

Expect a remainder: plans on BINs no document prints. Those are the ones to ask the PSAO about,
listed with their claim volume so the largest is asked about first.

## 5. MAC appeals, automated as far as is honest

`src/lib/appeal-packet.ts` assembles an appeal from six facts the site holds: the claim, what it
paid, what the contract says it should have paid (§3), the invoice line proving acquisition cost,
the deadline (window days from the basis the contract names), and where it goes (the PBM's
channel and target). It refuses, with every reason listed, when a part is missing: no appeal terms
for the PBM, a rate that cannot be priced, an invoice the PBM requires and the site lacks, a window
already closed, a shortfall under the materiality line.

The flow, once the pages exist: the claims paid under the contract figure or under acquisition
cost are queued; each becomes a packet; the packet is sent by the PBM's channel (email through the
pharmacy's own mailbox where the PBM accepts email; otherwise the fields and attachments are
prepared for the portal, which the site cannot drive on the pharmacy's behalf); the sending is
logged against the claim with the deadline and the response time, and the next remittance on that
claim scores the outcome, exactly as the recommendation log scores a switch of NDC.

## 6. The 835, and having it sent to the site

A contract states who pays, how, on what cycle, whether an 835 is offered and how enrollment is
changed. It does not itself change the routing; that is an EFT/ERA enrollment on each PBM's portal
or form, sometimes through a clearinghouse. What the site needs from the documents is the payment
path and the enrollment contact per PBM (§2), which land in `payment_routing` and `pbm_contacts`.

What the owner supplies once, for every enrollment: NPI, NCPDP, TIN, the bank letter, and a
**delivery point the site reads**. The site already reads a mailbox (`inbox`) and parses 835 files
(`x12-835.ts`, used today for the Medicare facilitator files). So the delivery point is a mailbox
address the site owns, or an SFTP folder the site watches; each PBM's ERA enrollment is pointed at
it, and the remittances then reconcile against the claims without anybody downloading anything.
The checklist per PBM (enrolled, delivery confirmed, first 835 received) is a page to build.

## 7. One run, kept for good

The library is read once. Three things make that true:

- **The schema asks for everything now.** Beyond the terms in §2: the network reimbursement
  ids printed in the exhibits (NCPDP 545-2F, the PBM's own name for the contract on a claim), the
  pharmacy's NCPDP and NPI where named, claim submission and reversal windows, every
  per-claim or per-transaction fee, each defined term (brand, generic, AWP, WAC, MAC, U&C,
  specialty, compound) as the document defines it, and a **map of the document**: every
  section and exhibit with its pages and one sentence on what it decides.
- **The raw answer is kept whole**, beside the document, and the full text of every PDF is
  indexed for search. A question nobody has asked yet is answered from the map and the text
  without reading the document again.
- **A field added later is one document's re-read, not the library's.** "Read again" on a row
  sends that document only; the accepted rows on the payer pages stand until replaced.

Before the run: every file in the folder; every portal download named in the manifest; the
Anthropic key on file and the monthly cap above the estimate the page shows. The run sends
every document with a file, read or not ("Read everything again"), through the Batch API at
high effort on the Opus-class model, one request per document, the prompt cached across the
run. Scans with no text are read as images and cost the same.

## 8. The run, in order

1. **Index** the folder (`indexContracts`): every PDF's text kept for search; scans flagged.
2. **Name** each document from the portal's manifest or its filename (`matchedBy`); the rest are
   named by hand before reading, because the counterparty is the first axis.
3. **Read** with the cost on screen first (`estimateCost`): the Batch API, one request per
   document, the schema and prompt cached across the run.
4. **Review** each draft as a checklist of proposals (`proposeFromContract`): every rate with its
   quote, new/same/changed against the tables; the appeal terms; the contacts; the payment path;
   the plans it governs with contested BINs marked; the caveats the document raised.
5. **Accept** what is right; it writes `network_rates`, `mac_appeal_terms`, `pbm_contacts`,
   `payment_routing`, `payer_links`, each row carrying the document and the quote.
6. **Group** the third parties by counterparty (`groupByCounterparty`): one page per payer with
   its chain of documents, its rates, its people, its payment path, its appeal terms.
7. **Price and appeal**: with links applied, every claim is priced on its contract; the shortfalls
   become packets (§5).
8. **Re-route**: the enrollment checklist (§6).

Steps 1 to 3 exist. Steps 4 to 8 are the pure modules named above plus the pages, which are on
the handoff for the pharmacy session (or this one) to build.
