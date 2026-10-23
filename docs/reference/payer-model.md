# The payer model: who priced a claim, and who pays it

*Draft, session 1, 8 September 2026. For helper A to audit before any migration is written.*

*Audited by A, 8 September: `docs/audits/2026-09-08-payer-model.md`. Twelve findings; two blocking
(the receivable cannot represent MTF money; `remittances` has no key against a re-sent file) and
both are left to session 1 because they change the shape of the model. **Five corrections A was
sure of are applied below and marked `[A]`.** Four reader faults the audit found are already fixed
on `work/payer-model-audit`, so the tables here can now actually be filled.*

## Why this exists

The owner, 7 September: *"To know the reimbursement of a claim we need to know the specific
contract id (group #, etc) but payments come from the payor (ie Caremark, Blue Cross, Optum, etc).
Payors will have many different BINs and groups under them. We also need to be thinking of data we
will need to completely reconcile payments to claim when we start getting 835s."*

Today the site keeps one string, `pbmName`, and asks it two different questions. That works only
while nobody looks closely. Two facts from the live database say why it cannot last:

- Of 177 contracts read, 63 identify themselves by **network name**, 39 by **chain code**, 5 by
  BIN, 0 by network reimbursement id. Claims carry **BIN (99.8%), PCN (94.4%), group (95.1%) and
  the network reimbursement id (95.3%, 82 distinct values)**, and no network name. The two sides
  are complete and speak different languages.
- Of 1,054 insured fills, 22 have more than one payor on the same dispensing. The fill's profit is
  one number; the money owed is two receivables settled by two different remittances.

So there are two answers to "who", and they are reached from opposite ends of the claim's life:

| Question | Reached from | Through | Answer |
| --- | --- | --- | --- |
| **Who priced it?** | the claim, at adjudication | its routing: BIN, PCN, group, network id, days supply, line of business | a **rate line** in a **contract** |
| **Who pays it?** | the remittance, weeks later | the 835's payer name (N1*PR) and payer id; the bank's deposit descriptor | a **payor** |

They are not the same entity. A PSAO's contract with Optum prices claims that Optum pays; Caremark
prices FEP claims that Blue Cross's Service Benefit Plan pays; a plan sponsor may pay directly
while the PBM adjudicates. The model has to let one contract price claims several payors pay, and
one payor pay claims priced under several contracts.

## The entities

Nine things, each with one key. Names in bold are new tables or renamed ones; the rest exist.

### 1. Payor — *who sends money*

One row per organisation that remits. Key: a canonical name the pharmacy chooses once
(`payors.name`), never a string from a file. Carries: every **payer name as printed on an 835**
(`N1*PR` strings — there will be several), every **payer id** (the 835's `N1*PR` id, tax id, EFT
trace prefix), the **bank descriptor** the deposit arrives under, and the bank descriptor
the deposit arrives under. A payor may be a PBM, a plan sponsor, a facilitator (the MTF), a PSAO
paying on behalf of its members, or a discount card company.

> **[A]** The ERA enrolment state does **not** belong here. You enrol for ERA with whoever
> *produces* the 835, which is the adjudicator: on FEP you enrol with Caremark and the file's
> `N1*PR` says Blue Cross. Keyed to the payor, `era_enrollments` gets one row per payor and asks the
> pharmacy to enrol with an organisation that sends no files. `era_enrollments` and `pbm_contacts`
> (help desks, audit contacts, network managers — all adjudicator-facing) key to the **processor**.
> `payment_routing`, which is where the money comes from, keys to the payor as written.

**Today:** there is no payor table. `pbmName` on claims, `network_rates.pbm_name`,
`payment_routing.pbm_name`, `era_enrollments.pbm_name` and `pbm_contacts.pbm_name` each carry a
free string that is sometimes a PBM, sometimes a plan, sometimes both. `reference.ts` resolves BIN
→ PBM name through a listing and a crosswalk.

### 2. Processor (PBM) — *who adjudicates*

One row per adjudicating entity, keyed by canonical name (`processors.name`). A processor owns
BINs: `payer_bins` becomes the BIN → processor table it already nearly is. A processor is often
also a payor (Caremark adjudicates and remits for many plans) — that is a link, not the same row,
because the FEP case above breaks it.

**Today:** `payer_bins` (BIN → `pbmName`, `collides` where one BIN serves several), `reference.ts`.

### 3. Contract document — *the paper*

`contract_docs`, as now: one row per PDF, with its counterparty (the processor or PSAO it is
with), its role (base, amendment, exhibit, rate sheet, manual), what it governs (chain codes,
NCPDPs), its dates, and the extraction. Unchanged.

### 4. Rate schedule — *what a contract pays*

`network_rates`, as now: one row per rate line, carrying the **network** (the name the document
gives it), the line of business, the days-supply band, the brand and generic formulas, the BINs,
PCNs and groups the line prints (usually none), effective dates and status. Keyed to its document.
Unchanged in shape; re-keyed from `pbm_name` to the contract document and, through it, to the
processor.

### 5. Network — *the name a contract uses for a rate book*

**New**, small: one row per network name a contract states (`networks.name`, the document that
states it, the processor it belongs to). The 82 **network reimbursement ids** on the claims map
onto these rows: `payer_links` already holds `contract_id` (the id PioneerRx prints) and
`contract_doc_id`; the row this design adds is the network the id belongs to, so a link is "id
BIDBRODCBR is the Prime AccessOne Network under this document", made once by the owner on the
networks page, and every claim on that id follows. `resolveContract` already reads the link.

### 6. Plan — *BIN, PCN, group*

`plan_groups`, as now: one row per BIN/PCN/group triple, with the plan's **class** (commercial
fully insured, self-funded, Medicare, Medicaid, discount card…), which decides which law governs
the fill and whether the Kansas floor applies. Keyed by the triple. Belongs to a processor (through
its BIN) and to a payor (who remits for it) — two links, because they differ.

> **[A]** The payor link must be **nullable, and its absence is a statement rather than a gap**: no
> payor means the whole fill is patient money and **there is no receivable**. On a discount card
> the patient pays the discounted price at the counter and nobody remits anything. Require a payor
> and every one of those fills opens a receivable for money that will never arrive, which then ages,
> which then reads as a lost remittance — a permanent false balance on the page whose entire job is
> telling the owner what he is owed. The receivable must read the null itself and never infer it
> from the plan class: a class is a label, the null is the fact. **Today 6 of 1,054
fills sit on a classified plan**; the owner classifies the top plans, and the site proposes a class
where the BIN listing states a line of business, never assumes one.

### 7. Claim and fill

`claims` (one row per transmission) and `fills` (one per dispensing, grouped by rx, fill, date,
NDC; not a table but a pure grouping). A claim resolves to a **rate line** through
`resolveContract` (owner link → document states the id → routing) and to a **plan** through its
triple. A fill owns the profit; each claim on it owns its receivable (`payerShares`).

### 8. Remittance — *the 835*

**New table** `remittances` (one per 835 file: payor as printed, payer id, the TRN trace number, the
payment and its date, the production date, the deposit it expects) and `remittance_lines` (one per
CLP: the pharmacy's claim reference as it comes back in CLP01, the payer's claim control number, the
date of service, the NDC where carried, and the charged, paid and patient-responsibility amounts)
and `remittance_adjustments` (one per PLB: the
provider-level money — DIR, recoupment, transaction fees, interest — with its reason code and the
payor's reference, belonging to no claim and still money). `x12-835.ts` exists and reads the file;
`claim_payments` holds later payments today and stays for the MTF, DIR, copay-card and manual
cases. A remittance line settles a claim's receivable by matching CLP01 to the rx and fill as
submitted, then the date of service and the NDC; nothing settles on amount alone.

> **[A]** Three corrections, all facts about the format rather than opinions about the model.
>
> **TRN has no amount.** `TRN02` is the trace and `TRN03` the originating company id; the amount is
> `BPR02` and the date the money moves is `BPR16`, which is not the production date (`DTM*405`).
> Written as it stood the migration would look for a field the format does not have.
>
> **The CAS adjustments cannot live on `remittance_lines`.** A CAS segment carries **up to six**
> adjustments, not one: `CAS01` is the group code and then reason/amount/quantity repeats through
> `CAS17/18/19`. One column set per line loses five in six. It needs a child table, one row per
> triplet — group, reason, amount, quantity — **and the loop it sat in**, because a claim-level and
> a service-level CAS for the same reason code are different money and flattening them adds the
> deduction twice on exactly the files where it is large enough to notice. `x12-835.ts` now reads
> them this way.
>
> **`remittances` needs a unique key against a re-sent file.** Every other import here has one —
> `claims.transaction_key`, `cash_receipts.source_key` (*"a date range gets re-run"*),
> `bank_lines.key`, `supplier_imports` — and an 835 is exactly the kind of file that arrives twice:
> re-sent by a clearinghouse, downloaded again by the MTF CLI, forwarded by the owner after it also
> reached the mailbox. Loaded twice it adds its whole value to revenue and settles every receivable
> in it twice, silently, and it is the largest single figure in the file. Build the key from `ISA13`
> and `ST02` where present, falling back to payer id + `TRN02` + `BPR02` + `BPR16`. The reader does
> not yet read `ISA13` or `ST02`, so this is a reader change as well as a column.

### 9. Deposit — *the bank line*

`bank_lines`, as now: one per line on the statement the owner uploads at month end. A deposit is
explained by one or more remittances (a TRN's amount and date) or by register takings; a deposit
nothing explains, or a remittance with no deposit, is a finding the books show.

## The keys, drawn once

```
processor ──owns──▶ BIN ──with PCN, group──▶ plan ──classified as──▶ law
    │                                          │
    └──counterparty──▶ contract doc ──▶ rate line ──named──▶ network ◀──tied by owner── network id (claim)
                                                                             │
claim ──routing──▶ rate line   (who priced it)                               │
claim ──triple──▶ plan                                                        │
fill = {claims} ──owns──▶ profit                                             │
claim ──owns──▶ receivable ──settled by──▶ remittance line ──belongs to──▶ remittance ──from──▶ payor
                                                                                       │
                                                        remittance ──explains──▶ deposit (bank line)
```

## What a claim must carry to be reconciled later

From the daily report today: rx number, fill number, date filled, NDC, quantity, BIN, PCN, group,
network id, remit, copay, patient total, acquisition. **Not carried and needed:** the PBM's
authorization number (NCPDP 503-F3), the quantity unit (600-28), the basis of reimbursement
(522-FM), and the pharmacy's own claim reference exactly as submitted (which is what CLP01 returns —
usually the rx number, sometimes rx-fill). These are PioneerRx export columns, or the SQL read the
owner is arranging. Until then a remittance line matches on rx, fill, date and NDC, and says when
it matched on fewer.

## What changes, in order, and what does not

1. **Nothing changes on screen until A has audited this.** The tables above are additive; no
   existing column is repurposed.
2. `payors` and `networks` are new; `remittances`, `remittance_lines`, `remittance_adjustments` are
   new. `payer_links` gains a `network_id` reference. `era_enrollments`, `payment_routing`,
   `pbm_contacts` gain a `payor_id` beside their `pbm_name`, filled by a one-time mapping the owner
   confirms.
2b. **[A]** `era_enrollments` and `pbm_contacts` gain a `processor_id`, not a `payor_id` — see
   §1. And prefer replacing `pbm_name` rather than sitting an id beside it: two columns meaning
   nearly the same thing with only one authoritative is how drift starts, and is how this whole
   problem began. Fill the id, make the name derived for display, and add a test that no decision
   reads the string.
3. `pbmName` on claims stays as the processor's name and is renamed in the code, not the database,
   to `processorName` where it means that, and replaced by `payorName` where it meant the other
   thing — module by module, each with a test that the two are not confused.
4. The payers page becomes a tree: payor → its BINs and groups → its contracts and rate lines →
   its enrolment state → its receivable, aged.

## Never

- Never match a payor, a processor or a network by name similarity. Names are typed by people at
  four different companies; a code the PBM printed on both sides, or a person's one-time choice,
  is the only join.
- Never settle a receivable on amount alone. Two claims for $12.83 on the same day are not the same
  claim.
- Never put patient money on a payor. It is the residual after the last plan.
- Never let a PLB adjustment disappear. It belongs to no claim and it is still money the books owe
  an explanation for.
- **[A]** Never post anything from a remittance whose own arithmetic does not close. `BPR02` is the
  claims less the provider-level adjustments; when it is not, a segment was not read and the
  difference is money. `parse835` now reports it and `importRemittance` posts nothing.
