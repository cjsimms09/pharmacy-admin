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
  tests re-run against the fixed code. After **c898bb4** it was taken a third time, at **16:48 UTC**.
  Section 1 · 7 says which run each result is from.
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

**Third run (code at c898bb4, fresh snapshot 16:48 UTC).** Session 1's fix makes the batch report the one
door for card takings. A Heartland credit in any spelling now places as `card_deposit`, which confirms a
batch or stays unplaced, and never banks. The form refuses an amount a feed already banked around that
month. The gate refuses a feed's receipt beside a typed, undated one of the same amount in the same month.
Reproduced:
- `readBankStatement`, `bank.ts` 88–150, including the `claimed` set shared across one statement's lines.
- `bankIt`, `page.tsx` 96–119, with "This is different money" not ticked. Both are signed-in actions, so
  **the form's new check was proved by calling `automaticReceiptsLike`, the function `bankIt` calls, and not
  through the page.**

| # | scenario | all three spellings (identical) |
|---|---|---|
| A | same batch forwarded twice | refused |
| B | batch first, deposit next day | `card_deposit` → **confirms** the batch |
| C | deposit read first, batch forwarded after | unplaced, nothing banked; batch banks once |
| D | two batches banked, then one deposit of both | ambiguous, nothing banked |
| E | one deposit of two batches read first, batches after | unplaced, nothing banked; both batches bank once |

Over-count per spelling: **$0.00, $0.00, $0.00.**

| # | hand path (spelling does not enter it) | result |
|---|---|---|
| H1 | batch 9/17 banked, same deposit typed for September | **form refuses** — "already banked automatically from Card batch on 2026-09-17" |
| H2 | typed for September, then batch 9/18 forwarded | **batch refused** — "already typed in by hand for 2026-09" |
| H1b | batch closed 9/30 banked, deposit typed for **October** | **form refuses** (its search runs 7 days either side of the month) |
| H2b | deposit typed for **October** (the bank date, 1 Oct), then the batch closed **9/30** forwarded | **both banked** — the gate compares typed receipts within the same month only |
| H1c | batches 9/24 and 9/25 banked, their **combined** deposit typed for September | **both banked** — the form looks for one receipt of the exact amount |

Hand-path over-count: **$685.50 — exactly H2b ($535.35) plus H1c ($150.15).**

| # | one statement, one card deposit and one PSAO deposit of the same cents | result |
|---|---|---|
| K | an HMA receipt of $987.65 banked 9/19; no batch on file; the statement carries a Heartland credit and an Access Health credit, both $987.65, on 9/20 | card line **confirms the HMA receipt**; the Access Health line, finding it claimed, is left unplaced; the batch forwarded afterwards banks. **$0.00 over**, but the card line is linked to the wrong receipt, and the PSAO line is left unplaced, though its money is on file. |

K is $0.00 here only because the Access Health spelling on record names no payer the site knows, so it
stays unplaced. By the code, a PSAO line that did name a payer would be placed as a deposit and banked
beside the HMA receipt, because `gateDeposit` never compares a receipt with no source key. That variant is the HMA/835 class session 1 has put in the 835 checkpoint, and it was not run here.

### Gaps for this feed

**G-CARD-1. A bank statement read before a batch is forwarded counted that money twice. — FIXED, 6ad1c04.**
OBSERVATION (first run): `bank.ts` 144 banked a statement deposit with no received date, so a batch
forwarded afterwards could not see it. $234.56 banked twice.
SHOULD BE: one deposit is one receipt whichever record reaches the site first.
FIXED: `bank.ts` 144 now passes `receivedOn: line.on`. Re-run: the later batch is refused, $0.00 over.
Third run (c898bb4): in C nothing is banked from the bank line, which stays unplaced, and the batch banks
once. $0.00 on all three spellings.

**G-CARD-2. One deposit covering two batches counted the money twice. — FIXED: batches first in 6ad1c04, deposit first (scenario E) in c898bb4.**
OBSERVATION (first run): batches $111.11 + $222.22, then one deposit $333.33, banked as new retail cash.
Second run, E: the combined deposit read before its batches banked as `retail`, and both batches banked
beside it, $393.97 over.
SHOULD BE: one deposit is one receipt whichever record reaches the site first.
FIXED: third run, D ambiguous and E unplaced with nothing banked, then both batches bank once. $0.00 on all
three spellings. Whether this bank ever combines batches is still **never-measured**; the fix no longer
depends on the answer.

**G-CARD-7. When the bank statement read first, the card money kept the bank's label and month. — FIXED, c898bb4.**
OBSERVATION (second run, C, clean spelling): the deposit banked as `retail` dated 9/23, and the batch closed
9/22 was refused, so the money's line and month depended on reading order.
SHOULD BE: the line and period a receipt lands in follow what the money is, never which document was read first.
FIXED: a card deposit never banks. The batch report is the only thing that banks card takings, always
`patient`, always at the close date. Third run, C: the batch banks, and the line stays unplaced.

**G-CARD-8. Heartland deposits in the spelling on record were unplaced, and the screen's advice for them doubled the money. — FIXED for H1 and H2, c898bb4; two narrower cases open as G-CARD-9 and G-CARD-10.**
OBSERVATION (second run): `placeLine` ignored the descriptor's `card_settlement`, so `HRTLAND`/`HRTI-AND`
credits were unplaced and the page said to bank them with the form. The form passed no date and no key, so
H1 (batch, then typed) and H2 (typed, then batch) both banked twice.
SHOULD BE: the site's own instruction for a line must never be the step that counts money twice.
FIXED:
- every spelling places as `card_deposit`;
- the unplaced line says to forward the batch report and not to use the form;
- the page footer says a card deposit is never banked by hand;
- the ambiguous message no longer says "confirm it by hand".
Third run: H1 refused by the form (proved at `automaticReceiptsLike`), H2 refused by the gate.

**G-CARD-9. A card deposit typed under the bank's month, for a batch that closed the month before, still counts twice.**
OBSERVATION: third run, H2b. A deposit of $535.35 was typed for October (the day it reached the bank, 1
October). The batch that closed 30 September was then forwarded, and both banked. The gate's new check
compares typed receipts **within the same month only** (`addCashReceipt` queries `month = input.month`). The
form's own check runs 7 days either side of the month (H1b, the reverse order, is refused), but the gate's
does not.
SHOULD BE: one deposit is one receipt; the month boundary is exactly where card money crosses (a batch
closed on the last day lands in the bank on the first), so it is the case a boundary check most needs to hold.
DIFFERENCE: yes, in code and on the copy. Reachable only if somebody types a card deposit despite the
screen saying not to. Dollars on live: **measured-and-none** (no typed receipts).
Owner: `expenses.ts` `addCashReceipt` and `deposit-gate.ts` — **1**.
Proposed fix: query typed receipts for the batch's month **and the month after** (the same widening
`automaticReceiptsLike` already uses), and compare across both.

**G-CARD-10. A combined deposit typed with the form, beside the two batches it covers, still counts twice.**
OBSERVATION: third run, H1c. Batches of $70.07 on 9/24 and $80.08 on 9/25 were banked, then their combined
$150.15 was typed for September, and both banked. `automaticReceiptsLike` looks for one receipt of the exact
amount. The ambiguous bank line now says *"banking it with the form would count it twice"*, but the form
itself does not refuse it.
SHOULD BE: as G-CARD-9 — an instruction on the screen is not a control; the form is where the double is made.
DIFFERENCE: yes, in code and on the copy. Reachable only against the screen's own words. Dollars: **measured-and-none**.
Owner: `money/page.tsx` — **A**; `expenses.ts` — **1**.
Proposed fix: `automaticReceiptsLike` also looks for 2–3 automatic receipts summing exactly, the same search
`matchHeldDeposit` does, and names them.

**G-CARD-11. A card deposit can confirm a receipt that is not a card batch.**
OBSERVATION: third run, K. With no batch on file, a Heartland credit of $987.65 confirmed a Health Mart
Atlas receipt of $987.65 banked the day before. `matchHeldDeposit` confirms a single candidate whatever its
payer; the payer is only used to choose between several. In the same statement the Access Health line of
that amount then found its receipt claimed and was left unplaced. Money: $0.00 over in this run. The card
line is linked to the wrong receipt, and the PSAO line sits unplaced with its money on file.
SHOULD BE: a card deposit is evidence about card takings only; it confirms a card batch or nothing.
DIFFERENCE: yes. Needs two deposits of the same cents within 7 days, one card and one not. How often: **never-measured**.
Where the other line names a known payer, it would bank beside the claimed receipt. That variant is left
to the 835 checkpoint, as session 1 asked.
Owner: `deposit-gate.ts` — **1**; `money/bank.ts` — **A**.
Proposed fix: for `card_deposit`, restrict candidates to receipts keyed `card-batch|…` before counting them.

**G-CARD-12. An unplaced card deposit is never re-matched when its batch arrives. (Recorded for session 1, who found it.)**
OBSERVATION: third run, C and E. The bank line stays unplaced, and the batch forwarded afterwards banks the
money correctly. Nothing in `src` updates a bank line after it is written (measured in the second run), so
the line stays on the unplaced list saying to forward a report that has already been forwarded.
SHOULD BE: a list of work to do shrinks when the work is done; a stale instruction teaches a person to ignore the list.
DIFFERENCE: yes. Not a money error; a stale list.
Owner: `money/bank.ts` — **A**; the card batch reader, `card-batch-store.ts` — **1**.
Proposed fix: when a batch banks, link any unplaced `card_deposit` line of the same amount inside the
window, or have the list re-run `matchHeldDeposit` on unplaced credits each time it is drawn.

**Order of forwarding.** Under c898bb4, reading the first bank statement before the three unforwarded
batches (1, 2 and 12 September) no longer counts anything twice; their deposit lines wait unplaced (G-CARD-12).
Still: **don't type a Heartland deposit in by hand** (G-CARD-9, G-CARD-10).

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
- Which spelling the bank's CSV export gives Heartland: never-measured. The runs cover the two spellings
  on record and the clean one. Any spelling that `card_settlement`'s pattern (`HRT[A-Z]?[LIT]?AND|HEARTLAND`,
  on squashed letters) misses would fall back to the generic rules, and that was not tried.
- `readBankStatement` and `bankIt` were not called; both are signed-in actions and were reproduced line
  for line (bank.ts 88–150, page.tsx 96–119 at c898bb4). `placeLines` (plural) was not exercised; it
  differs from `placeLine` only in consuming open bills and invoices, which a credit never touches.
- The "This is different money" tick was not exercised; by the code it skips the form's check entirely.
- The re-run's test rows stay on the scratch copy, not live, and go when the copy is deleted.
- Card sales after 14 September: none received at the time of reading.
