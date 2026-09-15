# The money map — how money and data come in, and where they land

**Phase A audit, read-only and measured. Written by session 2 for session 1. Nothing here has been
fixed; Phase B is split by file ownership once session 1 has read it.**

The owner, 15 September 2026: *"complete audit of money and data receiving, do we understand what
everything is, how to apply it, how to match it, are we setup to receive it properly and not get
errors … we need to understand how everything links together between claims, credit card fees, 835s,
expenses, bank statements, invoices, cogs, etc"*.

---

## How this was measured, so it can be re-run and disagreed with

- **Code** read at `origin/feature/compliance` **5cdff17** (15 September 2026). File and line references
  are to that commit.
- **Live numbers**: read-only SELECT queries against the live database, owner-approved 15 September 2026
  in the auditing session. The probe opens its own client and issues no PRAGMA, so it cannot write.
  Probes live in `scripts/support/probe-*.ts` for the length of the audit and are deleted afterwards.
- **Duplicate tests** (question 7): run against a **scratch snapshot** of the live database taken with
  `VACUUM INTO` at 16:15 UTC on 15 September 2026 — outside the repository and outside `data/`,
  owner-approved. Every writing probe refuses to start unless its database is that copy, and that guard
  was tested against the live path first (it refused, exit 2). The copy is deleted when the audit ends.
- **Masking**: no patient names, dates of birth or identifiers anywhere below. Processor batch numbers are
  shown last four digits only. Dollar figures are business totals.
- **Status words** follow CLAUDE.md rule 5: *captured · expected-not-yet · never-measured ·
  measured-and-none · not-captured*. "Missing" is not used.
- Figures attributed to **session 1** were measured by session 1 and are quoted, not re-measured, unless
  the entry says so.

Live row counts at the time of reading, for scale:

| table | rows |
|---|---:|
| claims | 3,923 |
| claim_payments | 9,585 |
| cash_receipts | 115 |
| expenses | 3 |
| supplier_invoices | 45 |
| invoice_lines | 468 |
| pioneer_purchases | 108 |
| supplier_statement_lines | 72 |
| bank_lines | **0** — no bank statement has ever been read |
| inbox_items | 136 |
| documents | 228 |

Cross-checks that the read was of the right database: 9,585 claim payments is exactly session 1's
figure from its post-deploy invariant check, and $34,112.41 of patient cash is exactly session 1's
card-batch total.

---

## 1. Credit card batches

**Checkpoint 1 of the audit. Code at 5cdff17; live numbers and the scratch-copy tests 15 September 2026.**

### 1 · What it is, who sends it, how often, through which door

A settlement batch from the card processor (Global Payments / Heartland): one email per batch, sent by
staff from **@wwfppa.com**, subject `Credit Card Batch (<batch>, <m/d/yyyy>) Report: $<total>, <n>
Transactions`, with two HTML attachments. The Summary attachment is the table the reader uses.
`card-batch.ts` (pure), `card-batch-store.ts` (banks it).

**Door: the mailbox sweep**, in the branch for messages with **no acceptable attachment**
(`mailbox.ts` ~494). `.html` is not an accepted type (`autoroute.ts` 472), so a batch email has no
acceptable attachment and reaches this branch. Order inside the branch: postage → Health Mart Atlas EFT
notice → **card batch** → "declined" record.

**Frequency**: daily, business days. **Captured on live data**, 3–14 September:

| closed | day | total |
|---|---|---:|
| 3 Sep | Thu | $2,704.35 |
| 4 Sep | Fri | $4,614.73 |
| 5 Sep | Sat | $2,217.44 |
| 8 Sep | Tue | $4,229.27 |
| 9 Sep | Wed | $4,115.66 |
| 10 Sep | Thu | $5,769.36 |
| 11 Sep | Fri | $6,445.84 |
| 14 Sep | Mon | $4,015.76 |
| **8 batches** | | **$34,112.41** |

No batch for **1 Sep (Tue), 2 Sep (Wed), 12 Sep (Sat)**. None expected for 6, 7 (Labor Day) or 13
September: measured, no claim was sold on any of those three days. See gaps.

### 2 · Recognised automatically? Malformed or lookalike — loud or silent?

**Recognition is by subject alone** (`looksLikeCardBatch`, `card-batch.ts`), from any sender that passes
the mailbox's allow-list. Nothing earlier in the branch can claim a batch email: the postage reader needs
a registered postage vendor and the subject "purchase confirmation" (`postage-email.ts` 61–65); the EFT
notice reader needs its own subject and the sentence "electronic funds transfer for … is complete"
(`health-mart-eft.ts` 76–80). The vendor-bill rule sits in `importRecognised`, which this branch never
reaches, so a vendor registered with a @wwfppa.com address cannot turn a batch into a draft bill
(session 1's lead — checked, and not a risk for this feed).

Malformed input is **loud**: no Summary attachment → "Held, nothing stored … needs the Summary Report"
(store 27–28); a figure that will not read, or any self-check failing → "Not banked" with the reason,
written to the inbox line as *Held*.

**Live**: 8 inbox items carry a batch subject; **8 of 8** routed `card_batch`, status stored, none held,
none elsewhere. **Measured-and-none** misrouted.

**Not yet observed: the automatic door on its own.** All 8 receipts were created by **"Session 1,
backfill"** within 87 ms at 15:30:12 UTC on 15 September, twelve minutes after staff forwarded the emails
(15:16–15:18). The sweep's handler code ran — the inbox lines, the audit events and the receipts are all
the `bankCardBatch` path — but it was invoked by a backfill (the caller passed that name), not by the
scheduled sweep. The emails arrived 15:16–15:18; the backfill banked them twelve to fourteen minutes later.
The first proof that a batch banks with nobody's hand on it is the next batch email arriving by itself.

**One silent path exists in code and has not occurred.** `.png`, `.jpg` and `.pdf` *are* accepted types.
A forwarded batch email that picks up an image (a mail-client signature, an inline logo) has an
acceptable attachment, so it takes the attachment branch instead, and `bankCardBatch` is never called.
The image would be filed as an unrecognised document and the batch money would never bank, with nothing
saying a batch was missed. Measured: 0 of 8 affected.

### 3 · Read correctly? Do the self-checks run, and could they pass for the wrong reason?

Seven checks before anything is banked (`readCardBatch`, 85–125): the subject's batch number equals the
summary's; the totals row is readable; card types sum to the total; sales plus returns sum to the total;
credit plus debit sum to the total; the subject's amount equals the total; the subject's count equals the
summary's.

**Two of the seven compare against the email subject**, which does not come from the HTML table, so a
misread table cannot agree with itself and pass. Returns are negative and already inside the total
(verified by the reader's own note on the 8 September batch: $4,262.08 sales − $32.81 returns =
$4,229.27, which is the live receipt above).

**Fragility, fails loud**: `cellsOf` drops empty cells (`.filter(Boolean)`), so a blank cell shifts the
eleven-cell stride. The card-type loop then reads a figure where a name should be, `int()` returns null,
the loop stops short, and "the card types come to …" refuses the batch. Loud, not wrong.

**What none of them can catch**: a processor report that is itself wrong. The independent check for that
is the bank deposit, which has not yet been read (`bank_lines` = 0) — and the card statement's deposit
cross-check, which has not yet run on a statement (0 card statement fee bills on file).

### 4 · Where it lands, and which date decides the month

`cash_receipts`, **kind `patient`**, payer "Card batch", `sourceKey card-batch|<batch>`, `reference`
= batch number, **`receivedOn` = the day the batch closed**, **`month` = that day's month**
(store 69–80). `out_of_books` follows `isOutOfBooks(closedOn)`.

**Live**: 8 of 8 in books (`out_of_books` = 0), 8 of 8 with the summary kept as a document.

The month is the **close date**, not the date the money reaches the bank. A deposit follows a business
day or two after close. Measured exposure so far: **0 batches** closed on the 28th or later — September is
not over. See gaps.

### 5 · Which basis reads it — exactly once on each?

**Cash: once.** `monthlyPL` cash revenue groups `cash_receipts` by kind (`profit-and-loss.ts` 364–376),
and kind `patient` is "Patient payments banked".
**Accrual: never.** Accrual revenue reads the System Sales Summary and the claims (285–349) and does not
read `cash_receipts` for revenue at all. Card takings are already in accrual as what patients paid at
pickup.

**Proven on the live numbers** — the site's own `monthlyAccount("2026-09", …)` run on the snapshot, with
this audit's synthetic test rows removed first:

| September 2026 | cash | accrual |
|---|---:|---:|
| Third-party | $275,121.78 | $202,679.48 |
| **Patient** | **$34,112.41** | $43,574.09 |
| Facilitator | $2,789.08 | — |
| Retail and OTC | — | $3,490.76 |

Cash "Patient payments banked" is **exactly** the 8 batches, and there are **0** patient receipts that
are not card batches. Accrual "Patient payments" ($43,574.09) comes from claims and the till and contains
no batch. **The two patient figures measure different things** — accrual is everything patients owed on
fills collected in the month, cash is card settlements for 3–14 September only — and their difference
cannot be split into cash, cheque, charge account and uncollected without a payment-type breakdown. It is
not a shortfall and must not be reported as one.

### 6 · What it matches to, on what key, and the match rate

| matched against | key | status |
|---|---|---|
| Claims (what patients owed) | day, `claims.sold_on` = batch close date | **Session 1 measured**, 3–14 Sep: $34,112.41 card against $37,321.21 owed by patients on claims sold those days, **91.4%** overall, 74–128% a day. Within a range, not to the penny: no tender breakdown exists. |
| Bank deposit | exact amount, ±7 days, one-to-one (`matchHeldDeposit`) | **expected-not-yet** — no bank statement read (`bank_lines` = 0) |
| Card statement batch line | batch date ±1 day and exact amount, not batch number — the email's batch ID and the statement's sequence number are different series (`card-statement-store.ts` 97–111) | **expected-not-yet** — no card statement read. Its own note: the first statement able to cross-check batches already on file is **October's** |
| POS tender (card / cash / cheque / charge) | — | **not-captured**; the owner will send PioneerRx payment-type reports, which are what would make batch = POS card = bank deposit exact |

Unmatched on live data, classified:

| day | patients owed (session 1) | card batch | status |
|---|---:|---|---|
| 1 Sep | $2,485.43 | none | **expected-not-yet** — measured: no batch-subject email for this day anywhere in the inbox, and no item at all from @wwfppa.com received that day. It never arrived, rather than arriving and being misfiled. |
| 2 Sep | $3,319.09 | none | **expected-not-yet** — as above |
| 12 Sep | $1,428.25 | none | **expected-not-yet** — as above |

### 7 · Duplication — what stops the same money counting twice?

Run on the scratch snapshot, calling the site's real `addCashReceipt` (and through it the real
`gateDeposit`) and the real `matchHeldDeposit`, against real neighbouring rows. The bank-statement step
reproduces `src/app/(app)/money/bank.ts` 88–146 argument for argument; it is not a call to that module,
which is a signed-in action.

| # | scenario | result |
|---|---|---|
| A | the same batch report forwarded twice | **refused** by `sourceKey`. Also true on live data: the reader ran **16 times** over the 8 emails, banked 8, refused 8 as already on file. |
| B | batch banked first, bank deposit the next day | **confirms** the batch receipt; nothing new banked |
| C | **bank statement read first, batch forwarded afterwards** | **counted twice** — both banked |
| D | **two batches settled in one deposit** | **counted twice** — the deposit matches neither batch alone and banks as new `retail` cash on top of both |

Test money genuinely in across B–D: $691.34. Receipts the tests added: $1,259.23. **Over-count $567.89 —
exactly scenario C ($234.56) plus scenario D ($333.33).**

Why C doubles, from the code, on three independent points: `bank.ts` 144 banks a deposit with **no
`receivedOn`, no `sourceKey` and no `reference`**. So a later feed cannot see it — the window query in
`addCashReceipt` excludes a null date; `withinWindow` returns false on a null date (`deposit-gate.ts` 77);
and there is no reference to match (97–115).

### Gaps for this feed

**G-CARD-1. A bank statement read before a batch is forwarded counts that money twice.**
OBSERVATION: `bank.ts` 144 banks a statement deposit with no received date, source key or reference, so
no receipt arriving afterwards can see it. Proven on the snapshot: $234.56 banked twice.
SHOULD BE: one deposit is one receipt whichever record reaches the site first. A cash account must not
depend on the order its documents happen to be read in.
DIFFERENCE: yes. **The trigger is in the plan as it stands**: the owner is to forward 1, 2 and 12 September,
and if the first bank statement is read before those arrive, their card money counts twice.
Dollars: the card portion of those three days — **never-measured** (patients owed $7,232.77 across them).
Owner: `src/app/(app)/money/bank.ts` — **A**.
Proposed fix: pass `receivedOn: line.on` and a stable `sourceKey` (`bank|<line key>`) at 144, so the later
batch meets it in the gate. Note the trade-off to decide in Phase B: the gate would then *refuse* the
batch and keep the bank's `retail` receipt, when the right outcome is one receipt labelled `patient` — so
the later batch should confirm or relabel the bank receipt, not merely be refused.
**Until fixed: forward the three missing batches before the first bank statement is read.**

**G-CARD-2. One deposit covering two batches counts the money twice.**
OBSERVATION: `matchHeldDeposit` needs one receipt of exactly the deposit's amount. Proven on the
snapshot: batches $111.11 + $222.22, one deposit $333.33, deposit banked as new retail cash.
SHOULD BE: a deposit that settles several batches confirms all of them. Processors routinely settle a
weekend or a holiday as one deposit.
DIFFERENCE: yes in code. **Whether it happens here is never-measured** — and only the **bank** statement
can show it. The card statement lists each batch on its own line with its own sequence number and matches
batch for batch, so it would show two clean batches and never reveal that the bank received them as one
deposit. The first bank statement is the first evidence either way.
Owner: `deposit-gate.ts` — **not in the ownership table**.
Proposed fix: where no single receipt matches, try combinations of unclaimed card-batch receipts inside
the window (bounded, card batches only, exact cents), and confirm all of them; anything ambiguous goes to
a person rather than being guessed.

**G-CARD-3. A batch email that picks up an image attachment is never banked, silently.**
OBSERVATION: the batch reader runs only when a message has no acceptable attachment; `.png`/`.jpg`/`.pdf`
are acceptable. Measured: 0 of 8 affected.
SHOULD BE: a report the site recognises by its subject must not go unbanked because of something else
riding on the same email.
DIFFERENCE: code path exists; has not occurred.
Owner: `mailbox.ts` routing — **B**.
Proposed fix: test the subject with `looksLikeCardBatch` before choosing a branch, and run the batch
reader on the declined HTML whatever else is attached.

**G-CARD-4. The automatic door has not yet banked a batch by itself.**
OBSERVATION: all 8 live receipts were banked by a Session 1 backfill, not by the scheduled sweep.
SHOULD BE: a daily feed is proven by its first unattended arrival.
DIFFERENCE: not a fault — an unobserved state. **never-measured**. Check the next batch email's
`cash_receipts.created_by` is the sweep, not a person.
Owner: none; an observation to close.

**G-CARD-5. No payment-type breakdown, so card cannot reconcile to copays to the penny.**
**expected-not-yet** — the owner will send PioneerRx reports of card, cash, cheque and charge-account
payments; session 1 judges whether they are sufficient. It is what would make card batch = POS card =
bank deposit exact.

**G-CARD-6. Charge accounts.** The owner: *"rarely but sometimes they do and it is registered as an AR
charge."* Accrual is unaffected (the claim's patient amount counts at sale). Cash counts it when the
patient later pays at the till. The gap: the site holds no record of what is owed on accounts, and a copay
charged that day makes that day's card total look short against copays. How rare — **never-measured**;
for the payment-type report to show.

**Q-CARD-1 (question for the owner). Which day does a card sale belong to on the cash account — the day
the batch closed, or the day the money reached the bank?**
The site uses the close date. On a strict cash basis it is the bank date, and the owner has said batches
"should match bank statement deposits"; many small practices use the settlement date instead, which is
also defensible. The difference is only the batches that close on a month's last business day or two:
**measured-and-none so far** (none closed on the 28th or later), first realised at the end of September.
Owner of the eventual change: `card-batch-store.ts` — **not in the ownership table**.

### Not checked, said out loud

- The **Global Payments card statement** reader (5cdff17) against a real statement: none has been read.
  Audited in its own checkpoint.
- Whether any real deposit combines two batches (G-CARD-2): needs a statement.
- The `retail` label a bank deposit takes when no batch matches (session 1's lead): confirmed in code
  (`bank-statement.ts` 260), and the real outcome depends on G-CARD-1 and G-CARD-2, neither of which has
  occurred on live data.
- Card sales after 14 September: none received at the time of reading.
