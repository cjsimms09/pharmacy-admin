# Audit: `docs/reference/payer-model.md`

8 September 2026 · Helper A · branch `work/payer-model-audit`

The design is sound and I would build on it. The payor/processor split is the right cut and the
"never" list is the best part of the document. What follows is what I would change **before a
migration is written**, because every one of these is cheap on paper and expensive after.

Two things were pressed hardest, as asked: the remittance tables against `x12-835.ts` and
`era-request.ts`, and whether the split survives every case.

**Verdict: twelve findings, two of them blocking** — F1 (the receivable cannot represent MTF money)
and F5 (no re-send key). The rest are corrections to the document, not to the idea.

**F2, F3, F4 and F8 are fixed on this branch**, because they were reader faults rather than model
faults and the reader could not have filled the tables as drawn. Helper B found three of the four
first and did not patch them — `x12-835.ts` is not in B's group and `claim-payments.ts` is in mine
(ASSIGNMENTS, "the rest of the claims audit"). B's write-up is
`docs/audits/2026-09-08-835-reconciliation.md` and its diagnosis is sharper than mine was; the
credit is theirs.

---

## Part 1 — the remittance tables against the reader

### F1 · Blocking · A remittance line cannot be both "settles a receivable" and "adds money the claim never carried"

The model draws one arrow: `claim ──owns──▶ receivable ──settled by──▶ remittance line`. The
Medicare Transaction Facilitator breaks it, and the MTF is the *first* payer this pharmacy will
receive 835s from.

A Part D fill adjudicates at, say, $54.20, and the claim's receivable is $54.20. Weeks later the
MTF remits the manufacturer discount — money the claim **never carried**, which is why `fills.ts`
holds it separately as `laterPaymentsCents` and why `claim_payments.revenue_cents` exists at all
(its own comment: *"How much of this payment is money the claim did not already carry"*). Under the
model as drawn, that remittance line settles a receivable of $54.20 with a payment that has nothing
to do with it, and one of two things happens: the receivable goes negative, or the money is dropped.

The same shape appears in reverse for the RxRescue case already handled in `claim_payments`: a
credit memo that settles copay assistance the claim *was* adjudicated for is not new revenue, and
adding the whole amount double-counts $1,096.91 on one real fill.

**Change:** a remittance line carries a **kind**, and it is not optional:

- `settles` — money against an amount the claim was adjudicated for. Reduces the receivable.
- `adds` — money the claim never carried (MTF discount, a top-off). Revenue in the fill's month on
  the accrual basis, cash on the deposit date, and **it never touches the receivable**.
- `takes_back` — a reversal or recoupment. Reduces revenue and reopens the receivable.

That is the same distinction `claim_payments.revenue_cents` already makes and the model quietly
loses when it replaces it. Without it, `payerShares` and the aged receivable are wrong for every
Part D fill in the pharmacy.

### F2 · Fixed · The four things the reader did not read that the tables require

The model's `remittances` and `remittance_lines` named fields `parse835` did not produce, so the
migration would have been written against a reader that could not fill it. Found by B; fixed here.

| The tables want | `x12-835.ts` before | Now |
| --- | --- | --- |
| **payer id** on the remittance | `case "N1"` read `f[2]` (the name) only | `Remittance.payerId` from `N1*PR*<name>*XV*<id>` |
| **production date** | `case "DTM"` was guarded by `if (current)`, and the header's `DTM*405` comes before the first `CLP` — dropped entirely | `Remittance.producedOn`, and the test says out loud that it is not `paidOn` |
| **the payer's claim control number** | `CLP07` (`f[7]`) not read | `RemittancePayment.controlNumber` |
| **every CAS adjustment, with group and reason code** | `CAS` fell to `default:` and survived only as an opaque string in `raw` | `RemittancePayment.adjustments`, one row per triplet, with its loop |

A correction to the document while I am here: **`remittances` cannot carry "the TRN trace number and
amount", because TRN has no amount element.** `TRN02` is the trace and `TRN03` the originating
company id; the amount is `BPR02` and the date the money moves is `BPR16`. Written as it stands the
migration would look for a field that does not exist in the format.

### F3 · Fixed · PLB was worse than dropped: it was filed against the last claim in the file

B's finding, and their phrasing is right — *"also worse than a drop"*. `PLB` appears after the last
`CLP` loop and before `SE`, and `current` was still open, so `default: if (current)
current.raw.push(seg)` filed **provider-level money as raw text against an unrelated
prescription**. Anything later mining `raw` would find a DIR fee attached to whichever patient
happened to be last in the file.

Fixed: `case "PLB"` now closes the open payment first and reads the adjustments into
`Remittance.providerAdjustments`, one row per reason/amount pair, keeping the payer's own reference
— which is the handle somebody quotes when they ring to ask what a deduction was.

And the money it accounts for now reaches a person. `claim-payments.ts` banks `BPR02`, which is net
of the PLB, while posting the claim payments gross — both figures individually right, the
difference invisible. The receipt it writes now says so in a sentence: *"The payer held back $57.50
at remittance level (CS DIRFEE0926), which is why this deposit is smaller than the claims it
settles. That money is not yet on either account."* That is not a home for it — F7 and the model's
`remittance_adjustments` are — but it is on the page where somebody reconciling the bank line will
read it, instead of a hole they have to derive.

### F4 · Fixed in the reader · `remittance_lines` cannot hold a CAS as the model describes it

Two errors of shape, and both are the standard 835 modelling mistake:

- **A CAS segment carries up to six adjustments, not one.** `CAS01` is the group code; then
  `CAS02/03/04`, `CAS05/06/07`, … through `CAS17/18/19` are *reason / amount / quantity* triplets.
  One row per segment loses five of six. It must be **one row per triplet**, carrying group, reason,
  amount and quantity.
- **A CAS can sit in the claim loop or the service loop.** In pharmacy 835s it is usually claim
  level, but not always, and a claim-level and service-level CAS for the same reason code are
  different money. The row must say which loop it came from, or the adjustments double-count on
  exactly the files where it matters.

The reader now does both — `Adjustment` carries group, reason, amount, quantity and `loop`, and the
loop is tracked by whether `SVC` has opened rather than inferred from the fields already read (the
service date arrives on a `DTM` that sits *before* `SVC` in most files, so the obvious proxy would
file every claim-level adjustment as a service-level one). **`remittance_lines` must not hold the
adjustments itself**: it needs a child table, one row per triplet, or five in six are lost.

### F5 · Blocking · `remittances` has no key against a re-sent file

Every other import in this site is keyed against being loaded twice — `claims.transaction_key`,
`cash_receipts.source_key` (whose comment says why: *"a date range gets re-run"*),
`bank_lines.key`, `supplier_imports`. `remittances` is given no such key, and an 835 is exactly the
kind of file that arrives twice: re-sent by a clearinghouse, downloaded again by the MTF CLI,
forwarded by the owner after it also reached the mailbox.

A remittance loaded twice adds its whole value to revenue and settles every receivable in it twice.
That is silent and it is the largest single number in the file.

**Change:** `remittances.key`, unique, built from the interchange control number (`ISA13`) and the
transaction set control number (`ST02`) where present, falling back to payer id + `TRN02` + `BPR02`
+ `BPR16`. `parse835` reads none of ISA13, ST02 or the BPR method today, so this is a reader change
as well as a column.

### F6 · The MTF will send 835s for money `claim_payments` already holds

The model says `claim_payments` *"stays for the MTF, DIR, copay-card and manual cases"*. But the
MTF's whole purpose in the ERA work is that it **sends 835s** — the reader's own doc comment opens
with *"This is what the Medicare Transaction Facilitator's CLI downloads."* So the same money will
arrive by both routes the moment enrolment succeeds, and today the payer payment report is already
banked into `claim_payments` and `cash_receipts`.

That is the seventh entry in the double-count register I built for the books this morning
(`src/lib/books-check.ts`), and it is not yet in it because the table does not exist. The model must
state the rule now, in the same words as the others: **the 835 wins, and a `claim_payments` row for
the same fill, source and amount is superseded rather than kept alongside** — with the supersession
recorded, not by deleting the row.

### F7 · The PSAO's fee has no home

`remittance_adjustments` is scoped to PLB — provider-level money *inside an 835*. A PSAO that
receives the PBM's remittance and passes it on takes its fee **outside** that file: the pharmacy
gets one deposit, net, and a PSAO statement that is not an 835.

Under the model that deposit is explained by remittances totalling more than the deposit, and the
difference is unexplained for ever. The adjustment table should not be PLB-shaped; it should be
*"provider-level money that belongs to no claim"*, with PLB as one source and a statement line as
another.

### F8 · Fixed · Nothing checked the arithmetic before anything was stored

CLAUDE.md: *"every reader that decides money is checked by arithmetic before anything is stored."*
An 835 is the most checkable document this pharmacy will ever receive, and the model stores it with
no check at all. Two identities close on a well-formed file:

```
per claim:   CLP03 (charged) − CLP04 (paid) − CLP05 (patient responsibility) = Σ CAS amounts
per file:    BPR02 (the payment) = Σ CLP04 − Σ PLB amounts
```

The second is the one that matters: it proves the file was read completely, and it fails the moment
PLB is mishandled (F3) or a CAS triplet is lost (F4). B named it as *"the fix worth making first"*
and they were right — it needs no schema change and turns a silent hole into a stated one.

Done. `Remittance.balance` carries the payment, the claims, the adjustments and the difference;
a difference becomes a problem in the reader's own words — *"a segment was not read, and the
difference is money"* — and `importRemittance` now **posts nothing at all** from a file whose
arithmetic does not close. The claims and the total are each individually believable; what is not
believable is their relationship, and that relationship is the whole reason to read an 835 rather
than take the deposit at face value.

Verified on a synthetic remittance that pays $3,942.50 against $4,000.00 of claims with a $57.50
DIR fee: it balances, and removing the PLB from the same file makes it fail by exactly $57.50.

---

## Part 2 — does the split survive every case?

The two-link design — a plan belongs to a **processor** through its BIN and to a **payor** who
remits, *and they are different links* — is correct, and it survives four of the five. The
document's own table is right about why.

| Case | Processor | Payor | Survives? |
| --- | --- | --- | --- |
| **FEP** | Caremark (owns the BIN) | Blue Cross Service Benefit Plan | **Yes.** This is exactly what the second link is for. |
| **Plan sponsor paying direct** | the PBM | the self-funded employer | **Yes**, and note the payor is per *group*, not per BIN — which the model already gets right by hanging the link on the plan triple rather than the BIN. |
| **PSAO paying on behalf of members** | the PBM | the PSAO | **Yes** for identity; **no** for the money — see F7. |
| **Medicare Transaction Facilitator** | not a processor at all | a payor for a component | **No** — see F1. The MTF is a payor of money that is not a receivable. |
| **Discount card** | the card company (its BIN) | **often nobody** | **No** — see F9. |

### F9 · A discount card plan has no payor, and the model has no way to say so

The owner, on his cash plan: *"pharmD claims should be imported but should know that is our cash
plan. this should just track margins on that."*

On a discount card the patient pays the discounted price at the counter and **no organisation
remits anything** — or the card company pays a dispensing fee only. The model requires every plan to
belong to a payor. Force one and every discount-card fill opens a receivable for money nobody will
ever send, which then ages, which then reads as a lost remittance. On this pharmacy's volume that is
a permanent false balance on the page whose entire job is telling the owner what he is owed.

**Change:** `plans.payor_id` is nullable and its absence is a *statement*, not a gap: **no payor
means the whole fill is patient money and there is no receivable.** The plan class already
distinguishes discount cards; the receivable must read the null rather than infer from the class,
because a class is a label and the null is the fact.

### F10 · The plan → payor link needs effective dates, and the rate lines already have them

A group changes payor at renewal, and in this industry renewal is 1 January for most of the book. A
2025 claim settled against the 2026 payor puts money on the wrong row, and the aged receivable —
the thing this model exists to make possible — is then wrong in both directions at once.

`network_rates` carries effective dates; `resolveContract` has `inForceOn()`. The payor link has
neither. It should carry `from` and `to` and be resolved as of the **date of service**, not today.

### F11 · Two of the three tables being re-keyed are processor-facing, not payor-facing

The document says `era_enrollments`, `payment_routing` and `pbm_contacts` all *"gain a `payor_id`
beside their `pbm_name`"*. Two of the three are the wrong entity:

- **`era_enrollments`** — you enrol for ERA with whoever **produces the 835**, which is the
  adjudicator. On FEP you enrol with Caremark and the file's `N1*PR` says Blue Cross. Keyed to the
  payor, this table gets one row per payor and asks the pharmacy to enrol with an organisation that
  does not send files. → **processor**.
- **`pbm_contacts`** — help desks, audit contacts, network managers. Adjudicator-facing. → **processor**.
- **`payment_routing`** — where the money comes from. → **payor**. Correct as written.

And a smaller one: *"gain a `payor_id` **beside** their `pbm_name`"* leaves two columns meaning
nearly the same thing with only one authoritative, which is how drift starts and how this whole
problem began. Fill the id, then make the name derived for display, with a test that no decision
reads the string.

---

## What I would not change

- **The "never" list is right, all four.** Especially *"never settle a receivable on amount alone"*
  and *"never put patient money on a payor"* — the second is what `payerShares` already enforces
  and it is the one people get wrong.
- **A canonical name chosen once, never a string from a file.** Correct, and the reason the site is
  in this position is that it did the other thing.
- **Network as its own small table, tied to the 82 network ids by one choice per id.** Correct, and
  it is the same rung `resolveContract` already reads. 82 choices once is a morning's work and it
  never has to be repeated.
- **Additive tables, nothing repurposed, nothing on screen until audited.** Right order.

## The one thing missing from "what changes, in order"

Step 4 is *"the payers page becomes a tree: payor → BINs and groups → contracts and rate lines →
enrolment state → **its receivable, aged**."* That last clause is the books' item, and it is the
thing the Money fold could not deliver this morning for exactly this reason. It needs F1, F9 and
F10 settled first — kind, nullable payor, effective dates — or the aged receivable is wrong for
every Part D fill, every discount-card fill, and every group that changed payor at renewal.

Worth saying plainly since it decides the order of the next two pieces of work: the period-level
receivable in the books is already right and does not depend on any of this. The **aged, by-payor**
receivable depends on all three.
