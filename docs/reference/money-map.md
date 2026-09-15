# The money map — how money and data come in, and where they land

**Phase A audit, read-only and measured. Written by session 2 for session 1. Phase B is split by file
ownership once session 1 has read it. A gap marked FIXED was fixed by its owner and re-tested here; the
entry names the commit.**

The owner, 15 September 2026: *"complete audit of money and data receiving, do we understand what
everything is, how to apply it, how to match it, are we setup to receive it properly and not get
errors … we need to understand how everything links together between claims, credit card fees, 835s,
expenses, bank statements, invoices, cogs, etc"*.

---

## How this was measured, so it can be re-run and disagreed with

- **Code** read at `origin/feature/compliance` **5cdff17**, and at **8394955** for the payment-type report
  added afterwards (both 15 September 2026). File and line references are to those commits.
- **Live numbers**: read-only SELECT queries against the live database, owner-approved 15 September 2026
  in the auditing session. The probe opens its own client and issues no PRAGMA, so it cannot write.
  Probes live in `scripts/support/probe-*.ts` for the length of the audit and are deleted afterwards.
- **Duplicate tests** (question 7): run against a **scratch snapshot** of the live database taken with
  `VACUUM INTO` at 16:15 UTC on 15 September 2026 — outside the repository and outside `data/`,
  owner-approved. Every writing probe refuses to start unless its database is that copy, and that guard
  was tested against the live path first (it refused, exit 2). The copy is deleted when the audit ends.
  After session 1's fix **6ad1c04**, the copy was deleted and taken again at **16:33 UTC** and the card
  tests re-run against the fixed code; section 1 · 7 says which run each result is from.
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

**Checkpoint 1 of the audit. Code at 5cdff17, updated at 8394955 for the payment-type report; live
numbers and the scratch-copy tests 15 September 2026.**

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
backfill"** within 87 ms at 15:30:12 UTC on 15 September. The sweep's handler code ran — the inbox lines, the audit events and the receipts are all
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

**Three of the seven compare against the email subject** — its batch number, its amount and its
transaction count — which does not come from the HTML table, so a misread table cannot agree with itself
and pass. Returns are negative and already inside the total
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
| POS tender (card / cash / cheque / charge) | PioneerRx "System Sales Totals By Payment Type": `card_net` (card less card refunds) against card-batch receipts with `receivedOn` inside the report's period (`sales-by-payment-store.ts` 74–90) | **reader built, nothing captured yet** — added in 8394955 after this checkpoint was first written. Live on 15 September: table `sales_by_payment` exists with **0 rows**, and **0** inbox items routed to it. The August sample session 1 read is not on the live database. The check has never run on real data. |

Unmatched on live data, classified:

| day | patients owed (session 1) | card batch | status |
|---|---:|---|---|
| 1 Sep | $2,485.43 | none | **expected-not-yet** — measured: no batch-subject email for this day anywhere in the inbox, and no item at all from @wwfppa.com received that day. It never arrived, rather than arriving and being misfiled. |
| 2 Sep | $3,319.09 | none | **expected-not-yet** — as above |
| 12 Sep | $1,428.25 | none | **expected-not-yet** — as above |

### 7 · Duplication — what stops the same money counting twice?

Run on the scratch snapshot, calling the site's real `addCashReceipt` (and through it the real
`gateDeposit`) and the real `matchHeldDeposit`, against real neighbouring rows. The bank-statement step
reproduces `src/app/(app)/money/bank.ts` 93–146 argument for argument; it is not a call to that module,
which is a signed-in action. Amounts and batch ids are synthetic.

**First run (code at 8394955, snapshot 16:15 UTC).** The bank line was given the placement `deposit /
retail / payer none` by hand rather than by the real classifier.

| # | scenario | result |
|---|---|---|
| A | the same batch report forwarded twice | **refused** by `sourceKey`. Also true on live data: the reader ran **16 times** over the 8 emails, banked 8, refused 8 as already on file. |
| B | batch banked first, bank deposit the next day | **confirms** the batch receipt; nothing new banked |
| C | bank statement read first, batch forwarded afterwards | **counted twice** — both banked |
| D | two batches settled in one deposit | **counted twice** — the deposit matched neither batch alone and banked as new `retail` cash on top of both |

Over-count $567.89 — exactly C ($234.56) plus D ($333.33). Cause of C: `bank.ts` 144 banked the deposit with
no `receivedOn`, so the window query in `addCashReceipt` and `withinWindow` could not see it.

**Correction to the first run, found on the re-run.** The hand-given placement is what the real
classifier returns only when the bank prints the name as **HEARTLAND**. The spellings the site has on
record from the real August statement — `HRTLAND PMT SYST TXNS`, `HRTI-AND PMT SYS/TXNS`
(`bank-descriptors.ts` header and its test) — do not match `RETAIL` in `bank-statement.ts` 188, which
has `\bheartland\b`. The real `placeLine` returns **unplaced** for them. So the first run proved C and D
for the clean spelling only. Which spelling the bank's CSV export carries is **never-measured**: the reader
takes CSV only, and the spellings on record came from a scanned PDF.

**Re-run (code at 6ad1c04, fresh snapshot 16:33 UTC).** The bank line was placed by the real `placeLine`,
with the copy's real payer and supplier names in its context. Three descriptions were tried, each with its
own amounts.

| # | scenario | `HRTLAND PMT SYST TXNS/DEPOSIT` and `HRTI-AND PMT SYS/TXNS` (identical results) | `HEARTLAND PAYMENT SYSTEMS DEPOSIT` |
|---|---|---|---|
| A | same batch forwarded twice | refused; 1 receipt carries the key | (same test) |
| B | batch first, deposit next day | placed unplaced → **confirms** the batch | placed retail → **confirms** the batch |
| C | deposit read first, batch forwarded after | deposit **left unplaced**, nothing banked; batch banked | deposit **banked as `retail`** dated 9/23; batch **refused** — "already banked under 2026-09-23" |
| D | two batches banked, then one deposit of both | **ambiguous** — names both batches, nothing banked | **ambiguous** — names both batches, nothing banked |
| E | *new:* one deposit of two batches read first, both batches forwarded after | deposit left unplaced; both batches banked | deposit **banked as `retail`**; **both batches banked** — counted twice |

Money genuinely in, per column, against what the tests added: scan spellings **$0.00 over** (twice);
clean spelling **$393.97 over — exactly scenario E**. **C and D as specified: $567.89 → $0.00 on every
spelling. FIXED by 6ad1c04.**

One more order, because the screen sends the unplaced lines to a person. The `/money` page lists them
under *"A deposit here is banked with the form above"* (`money/page.tsx` 428), and that form's action
(`bankIt`, 106) passes **no `receivedOn` and no `sourceKey`**. `gateDeposit` banks anything with no
source key without comparing it (`deposit-gate.ts`, *"Typed by a person: the bank statement is the record
and this does not argue with it"*), and a receipt with no date is outside every later feed's window.
Reproduced on the copy:

| # | scenario | result |
|---|---|---|
| H1 | batch banked, then the same deposit typed on `/money` (payer "Heartland") | **both banked** |
| H2 | deposit typed on `/money` first, then the batch forwarded | **both banked** |

Live exposure today: **measured-and-none** — all 115 receipts on the copy carry a source key and a
received date, and no bank line has ever been read.

### Gaps for this feed

**G-CARD-1. A bank statement read before a batch is forwarded counted that money twice. — FIXED, 6ad1c04.**
OBSERVATION (first run): `bank.ts` 144 banked a statement deposit with no received date, so a batch
forwarded afterwards could not see it. $234.56 banked twice.
SHOULD BE: one deposit is one receipt whichever record reaches the site first.
FIXED: `bank.ts` 144 now passes `receivedOn: line.on`. Re-run: the later batch is refused, $0.00 over.
What remains is G-CARD-7 (which label and month the money keeps) and G-CARD-8 (the spelling, and the hand path).

**G-CARD-2. One deposit covering two batches counted the money twice. — FIXED for batches-first, 6ad1c04; the reverse order is open.**
OBSERVATION (first run): batches $111.11 + $222.22, then one deposit $333.33, banked as new retail cash.
FIXED: `matchHeldDeposit` looks for 2–3 unclaimed receipts dated on or before the line, inside the window,
summing exactly, and returns ambiguous naming them. Re-run: nothing banked, on every spelling.
STILL OPEN, scenario E: the same combined deposit read **before** its batches, clean spelling —
OBSERVATION: the deposit banks as `retail`; each batch then meets no receipt of its own amount, and both
bank. $393.97 over on the test.
SHOULD BE: one deposit is one receipt whichever record reaches the site first (as G-CARD-1).
DIFFERENCE: yes, for the clean spelling. Needs both a combined deposit and the statement read first;
whether this bank ever combines batches is **never-measured**. Only the bank statement can show it, since
the card statement lists batch by batch. The header of `card-statement.ts` describes a processor statement
that is not on file here: *"Each batch reaches the bank whole, the next day, weekends included"*, one ACH line
per batch. That is evidence against, not proof.
Owner: `deposit-gate.ts` — **1**.
Proposed fix: the symmetric check in `gateDeposit`. A sourced receipt whose amount, with one or two other
held receipts, sums exactly to an unconfirmed bank-statement receipt in the window goes to a person, named.
It is never banked.

**G-CARD-7. When the bank statement reads first, the card money keeps the bank's label and month.**
OBSERVATION: re-run C, clean spelling. The deposit is banked as `retail`, month and date 9/23 (the bank
date). The batch closed 9/22 is refused. So $234.56 of card takings sits on the cash account's *retail*
line. Had the batch arrived first, it would sit on the *patient* line under the close date. Same dollars,
different line and possibly different month, **decided by reading order**.
SHOULD BE: the line and period a receipt lands in follow what the money is, never which document happened
to be read first. Accounts that shift with processing order can't be compared month to month.
DIFFERENCE: yes. The cash total is unaffected. The split between the patient and retail lines is, and the
month is too for a batch closing on a month's last day or two (see Q-CARD-1, with the owner via session 1).
Dollars: **never-measured** — it depends on how many batches arrive after their statement.
Owner: `money/bank.ts` — **A**; `deposit-gate.ts` — **1**.
Proposed fix: a sourced card-batch receipt that meets an unconfirmed bank-statement receipt of the same
amount inside the window **takes it over**: it keeps the batch's kind, date and key, and links the bank
line to it. A refusal leaves the bank's guess standing.

**G-CARD-8. Heartland deposits in the spelling on record are unplaced, and the screen's advice for them doubles the money.**
OBSERVATION: `bank-descriptors.ts` recognises `HRTLAND`/`HRTI-AND` deposits as `card_settlement`, category
patient, "the till". `placeLine` never reads that category, and its own `RETAIL` pattern knows only
`heartland`. **Two readers for one thing, disagreeing.** With no batch on file (orders C and E), the line
is left unplaced: *"a deposit from nobody the site knows; bank it by hand with the payer"*. The page
footer says a deposit here *"is banked with the form above"*. That form passes no date and no key, so the
gate never compares it and no later feed can see it: H1 and H2 both bank twice. The D fix's ambiguous line
says *"confirm it by hand"*. The screen has no way to confirm a line: nothing in `src` updates a bank line
after it is written. Its one instruction is the form, and typing that deposit in is H1: the two batches are
already banked, and the typed deposit banks on top.
SHOULD BE: the site's own instruction for a line must never be the step that counts money twice. A
deposit that a feed on the site will also bank should either wait for that feed or be linked to its
receipt, not typed again.
DIFFERENCE: yes. Live exposure **measured-and-none** (0 bank lines read, 0 receipts typed by hand). The
trigger is in the plan: the first bank statement, and the three unforwarded batches (1, 2, 12 September).
Owner: `bank-statement.ts` and `bank-descriptors.ts` — **not in the ownership table**; `money/page.tsx`
and `money/bank.ts` — **A**; `deposit-gate.ts` — **1**.
Proposed fix, four parts:
(a) `placeLine` places `card_settlement` from the descriptor, so one reader decides. (`counter_deposit`,
a bare "DEPOSIT", has the same disagreement. It is left to the till checkpoint, because what a counter
deposit is isn't settled here.)
(b) An unplaced card deposit says *"forward that day's batch; do not bank this by hand"*, as the card-fee
debit already does (`bank-statement.ts` 358).
(c) The `/money` form carries the day the money arrived, so a feed arriving later sees the hand receipt.
That closes H2 only. H1 stays open because `gateDeposit` never compares a receipt with no source key, dated
or not. The form also has to show any receipt of the same amount inside the window, and ask before banking
beside it. This part applies to every hand receipt, and the bank-statement checkpoint will measure it
across all feeds.
(d) The ambiguous line needs a confirm action on the screen: link the bank line to the receipts it names.
Until one exists, "confirm it by hand" has nothing to press.
**Until fixed: forward the three missing batches before the first bank statement is read** (unchanged from
checkpoint 1), and don't bank a Heartland line by hand.

**G-CARD-3. A batch email that picks up an image attachment is never banked, silently.**
OBSERVATION: the batch reader runs only when a message has no acceptable attachment; `.png`/`.jpg`/`.pdf`
are acceptable. Measured: 0 of 8 affected.
SHOULD BE: a report the site recognises by its subject must not go unbanked because of something else
riding on the same email.
DIFFERENCE: code path exists; has not occurred.
Owner: `mailbox.ts` routing — **B**. **Phase B** (session 1, 15 September): not to be fixed now.
Proposed fix: test the subject with `looksLikeCardBatch` before choosing a branch, and run the batch
reader on the declined HTML whatever else is attached.

**G-CARD-4. The automatic door has not yet banked a batch by itself.**
OBSERVATION: all 8 live receipts were banked by a Session 1 backfill, not by the scheduled sweep.
SHOULD BE: a daily feed is proven by its first unattended arrival.
DIFFERENCE: not a fault — an unobserved state. **never-measured**. Check the next batch email's
`cash_receipts.created_by` is the sweep, not a person.
Owner: none; an observation to close.

**G-CARD-5. The payment-type check exists and has never run on real data.**
OBSERVATION: session 1 built the reader for PioneerRx's "System Sales Totals By Payment Type" (8394955,
RouteKind `sales_by_payment`, migration 0121). It books nothing and checks two things: the till's card
figure against the card batches, and prescription money against the claims. On the live database: 0 rows,
0 inbox items.
SHOULD BE: the card batch, the till's card takings and the bank deposit are one sum of money seen three
ways, and a daily reconciliation should hold all three to the cent.
DIFFERENCE: **expected-not-yet** — the owner is to send the reports daily. Two joins are **unverified until
real September reports arrive**, and either can make a correct day read as a discrepancy:
- **the day boundary**: a batch is dated the day it *closed* (`receivedOn` = close date), the report the day
  of *sale*. A batch closed after midnight, or one holding the last sales of the day before, lands on a
  different day from the till's figure;
- **reversals**: the prescription check takes claims with `reversedOn` null, and whether PioneerRx nets a
  reversal out of the same period the same way is unknown.
Owner: `sales-by-payment*.ts` — **1** (session 1, 15 September; not yet in the ownership table).
Proposed: nothing to fix yet. Measure both joins on the first week of real reports before either check is
trusted to say a day is wrong.

**G-CARD-6. Charge accounts.** The owner: *"rarely but sometimes they do and it is registered as an AR
charge."* Accrual is unaffected (the claim's patient amount counts at sale). Cash counts it when the
patient later pays at the till. The gap: the site holds no record of what is owed on accounts, and a copay
charged that day makes that day's card total look short against copays. How rare — **never-measured**.
The payment-type report now has a column for it (`A/R / Direct Dep`, stored as `account_cents`), so the
first real reports will measure charges *to* accounts. See Q-CARD-2 for the half they may not show.

**Q-CARD-2 (question for the owner, raised by session 1). Does PioneerRx's "System Sales Totals By
Payment Type" report include money a patient pays *onto* a charge account, or only charges *to* one?**
The A/R column shows charges to accounts; whether a later payment against the account appears anywhere in
this report is unconfirmed. It matters for the card check: if account payments do not appear, then on a day
a patient pays off an account by card, the card batch holds that money and the till's card figure does not,
and the check reports the batches as holding more than the till — a correct day read as a discrepancy. If
they do appear, the check holds. Only the report's behaviour, or PioneerRx, can say which.

**Q-CARD-1 (question for the owner). Which day does a card sale belong to on the cash account — the day
the batch closed, or the day the money reached the bank?**
The site uses the close date. On a strict cash basis it is the bank date, and the owner has said batches
"should match bank statement deposits"; many small practices use the settlement date instead, which is
also defensible. The difference is only the batches that close on a month's last business day or two:
**measured-and-none so far** (none closed on the 28th or later), first realised at the end of September.
Owner of the eventual change: `card-batch-store.ts` — **1**. Session 1 is putting this question to the owner.

### Not checked, said out loud

- The **Global Payments card statement** reader (5cdff17) against a real statement: none has been read.
  Audited in its own checkpoint.
- Whether any real deposit combines two batches (G-CARD-2, scenario E): needs a bank statement.
- Which spelling the bank's CSV export gives Heartland (G-CARD-8): never-measured. The re-run covers the
  two spellings on record and the clean one, and no others.
- The `retail` label a bank deposit takes when no batch matches (session 1's lead): confirmed in code
  (`bank-statement.ts` 260), and only for the clean spelling (G-CARD-7, G-CARD-8).
- `readBankStatement` itself was not called. It is a signed-in action, so its lines 93–146 were reproduced
  instead, and `placeLines` (plural) was not exercised. It differs from `placeLine` only in consuming
  open bills and invoices, which a credit never touches.
- The re-run's test rows stay on the scratch copy, not live, and go when the copy is deleted.
- Card sales after 14 September: none received at the time of reading.
