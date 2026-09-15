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

**Fourth run (code at 56f0ce2 + 882307e, fresh snapshot 17:30 UTC)**, after session 1's fixes for G-CARD-9, -10
and -11. The reproductions follow the new code: a card deposit matched against `card-batch|…` receipts only,
and the form's check reporting combinations.
- A–E, all three spellings: **$0.00 over**.
- H1 refused. H1b refused. **H2b refused** by the gate: *"535.35 was already typed in by hand for 2026-10"*.
  **H1c refused** by the form: *"already banked automatically as 2 receipts together"*. Hand path: added
  $2,069.33, genuinely in $2,069.33.
- **K**: the card line stays unplaced (no batch), the Access Health line confirms the HMA receipt, and the
  batch forwarded afterwards banks. $0.00 over, **and each line linked to its own receipt.**
- One new behaviour, loud: in H2 the form refused a genuinely new $424.24. Two unrelated receipts already on
  the copy summed to it exactly ($313.13 from H1 and $111.11 from D). The person can tick "This is different
  money". The batch forwarded afterwards banked once. So H2's original order was not exercised this run; its
  gate path is the one H2b proves. How often real receipts produce such a coincidence: not measured.

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

**G-CARD-9. A card deposit typed under the bank's month, for a batch that closed the month before, still counts twice. — FIXED, 56f0ce2 (fourth run, H2b refused).**
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

**G-CARD-10. A combined deposit typed with the form, beside the two batches it covers, still counts twice. — FIXED, 56f0ce2 (fourth run, H1c refused).**
OBSERVATION: third run, H1c. Batches of $70.07 on 9/24 and $80.08 on 9/25 were banked, then their combined
$150.15 was typed for September, and both banked. `automaticReceiptsLike` looks for one receipt of the exact
amount. The ambiguous bank line now says *"banking it with the form would count it twice"*, but the form
itself does not refuse it.
SHOULD BE: as G-CARD-9 — an instruction on the screen is not a control; the form is where the double is made.
DIFFERENCE: yes, in code and on the copy. Reachable only against the screen's own words. Dollars: **measured-and-none**.
Owner: `money/page.tsx` — **A**; `expenses.ts` — **1**.
Proposed fix: `automaticReceiptsLike` also looks for 2–3 automatic receipts summing exactly, the same search
`matchHeldDeposit` does, and names them.

**G-CARD-11. A card deposit can confirm a receipt that is not a card batch. — FIXED, 56f0ce2 (fourth run, K).**
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

**G-CARD-13. The unplaced card-deposit line names the wrong day's batch report to forward.**
OBSERVATION: c898bb4's message is *"Forward the batch report for the day before ${line.on}"* (`bank.ts`,
card_deposit branch). Measured on August's real card statement against the real bank statement, one to one:
**0 of 25** batches closed the day before their bank credit. It was 2 days before for 16, 3 for 5 and 4 for 4.
A weekday batch reaches the bank two days later, and Monday's credits carry Thursday's, Friday's and
Saturday's batches (3 August: three Heartland credits).
SHOULD BE: an instruction names the thing to do. Pointing at the wrong day's report sends a person looking
for a report that belongs to a different deposit, or that does not exist, since there is no Sunday batch.
DIFFERENCE: yes, measured. Not a money error.
Owner: `money/bank.ts` — **A** (the line was written by session 1).
Proposed fix: name the amount, and the window the batch closed in, "2 to 4 days before", or better, list
the batch dates in that window with no batch report on file.

**August evidence on G-CARD-2 (combined deposits):** measured-and-none. All 25 August batches reached the
bank as separate credits of their own exact amount. The fix stands regardless.

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

**Q-CARD-1 — DECIDED by the owner, 15 September (via session 1): card money counts on the day the batch
closed.** He says it reaches the bank a day or two later. The code already does this. Measured on August's
real statements: close → bank credit is 2 days for 16 batches, 3 for 5, and 4 for 4. So the batches closed on
a month's last two to four days are cash in that month and reach the bank in the next.

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

---

## 2. The card processing statement (Global Payments / Heartland) — rehearsed

**Checkpoint 2, run as a rehearsal. The owner, 15 September: *"we have an example of everything we need..
we should be able to do test runs and make sure everything works"*. Code at 5cdff17 (reader and store),
with `bank.ts` at c898bb4.**

Samples used (the owner's uploads; nothing from them is in git):
- **the real August 2026 merchant statement** (7-page PDF);
- **the real August 2026 Emprise bank statement** (scanned PDF, 11 pages). No site reader takes it, so its
  Heartland lines — 26 credits and 1 debit — were read off the page images by eye and used only as an
  independent record to check the card statement against. The PDF holds 9 page images; the transactions
  end on the 9th with the daily balance summary, so the last two pages were not looked at.

Booking was rehearsed on a fresh snapshot (16:59 UTC).

### 1 · What it is, who sends it, how often, through which door

The processor's monthly statement, sent by staff from @wwfppa.com, which is also the batch reports'
domain. It carries:
- the month's fees by section: Visa, Mastercard, American Express and Discover pass-through, and Global
  Payments' own charges;
- one row per batch deposited;
- one fee auto-debit line.

Door: mailbox sweep → `classify` on the PDF's text (`autoroute.ts` 215) → `card_statement` →
`bookCardStatement` (`mailbox.ts` 908), ahead of the vendor-bill rule.
- **Rehearsed:** `classify` returns `card_statement` for the real sample.
- **Live:** the 10 PDFs already received from @wwfppa.com all reached `classify` (1 rebate report, 9
  AccessHealth payment PDFs), so nothing intercepts a PDF from that domain first.

### 2 · Recognised automatically? Malformed or lookalike — loud or silent?

Recognition needs three things in the text together: "Merchant Statement", a "Statement Period" with two
dates, and "Global Payments" or "Heartland" (`card-statement.ts` 78).
- The real sample is recognised.
- A scanned copy with no text layer is not: it is filed as "a PDF this does not recognise" and books
  nothing (synthetic test).
- A recognised statement whose own figures disagree is held with the reason, *"Held, nothing stored: …"*.
  That is loud.

### 3 · Read correctly? Do the self-checks run, and could they pass for the wrong reason?

**The real statement reads, and every check ran and agreed:**

| figure | read |
|---|---|
| period | 2026-08-01 to 2026-08-31, merchant …4875 |
| total deposits | $94,529.08 — 25 batch rows sum to it |
| total fees | $4,778.73 — 5 section subtotals sum to it: Visa $1,120.59, Mastercard $569.45, Amex $42.01, Discover $138.51, Global Payments $2,908.17 |
| processing summary | 2,430 transactions, sales $94,678.94, refunds −$149.86, net $94,529.08 = total deposits (the check ran) |
| fee auto-debit | printed 08/31/2026, $4,778.73 = total fees |

**Against an independent record, the bank statement:**
- **All 25 statement deposits equal a bank Heartland credit to the cent, one to one.** The 26th bank credit
  ($3,695.38 on 8/03) is July's statement's last deposit.
- So the reader's deposit figures are right, and in August **no deposit combined two batches**.
- Could the checks pass for the wrong reason? "Total fees" has to agree with the section subtotals and the
  printed debit; "total deposits" with the rows, the processing summary, and here the bank. That is four
  independent agreements.

118 money-bearing lines are read by no pattern. By their shapes (listed in the probe), all are per-card
fee detail inside the sections, and the subtotals already cover them.

Two quiet paths remain, shown only on synthetic shapes:
- the processing-summary check skips silently if its line is unfamiliar;
- an unfamiliar deposit-row shape outside the totals is ignored.

The real statement has neither.

**What the statement and the bank show about timing** (measured, August):
- batch close → processor ACH: 1 day, all 25;
- ACH → bank credit: 1–3 days (weekend ACHs post Monday);
- **batch close → bank credit: 2 days ×16, 3 days ×5, 4 days ×4.**
- The fee debit is printed for the month's last day. **July's fees ($5,183.71) left the bank on 3 August.
  August's ($4,778.73) are not on the August bank statement.** The fees leave the bank in the following month.

### 4 · Where it lands, and which date decides the month

Rehearsed on the copy, first **as it is**: the August 2026 statement is before the books, so it is kept and
nothing is booked.

Then **the same text with every date one year on** (August 2027 has the same days, so every date keeps its
day of the month):
- one bill, `GP-…4875-2027-08-31`, **$4,778.73**;
- invoiceDate 2027-08-31, paidOn 2027-08-31 (the printed debit date), confirmed;
- category "Card processing and bank fees" (operating), vendor "Global Payments (Heartland)".

The deposits are never booked; they are the batch reports' money (section 1).

### 5 · Which basis reads it — exactly once on each?

`expensesIn`: accrual by invoiceDate, cash by paidOn, confirmed bills only (`expenses.ts` 171). Rehearsed
with the real `monthlyAccount`:

| | accrual Aug | cash Aug | cash Sep |
|---|---|---|---|
| before the statement | absent (listed missing) | absent | absent |
| statement booked | **$4,778.73** | **$4,778.73** | absent |
| bank fee debit read, next business day 9/1 (`pays_bill`, then its audit event) | $4,778.73 | absent | **$4,778.73** |

Once on each basis. The cash month is the printed date until the bank statement is read, and the bank's date after.

### 6 · What it matches to, on what key, and the result

- **Statement batches ↔ card batch receipts**: batch date ±1 day and exact cents (`card-statement-store.ts`
  93–124). The rehearsal made receipts from 22 of the statement's 25 rows, plus July's real last deposit.
  It gave *"22 of its 25 batches match"* and named the 3 left out, with dates and amounts ($10,889.91).
  **Right.** It also said *"1 batch report on file for these dates matches no deposit"*, and that is
  **wrong** (G-CSTMT-2).
- **Fee bill ↔ bank fee debit**: exact cents among `GP-…` bills no bank line has claimed. August's
  $4,778.73 → `pays_bill`. July's $5,183.71 (no July statement on file) → unplaced, *"forward that month's
  statement"*.
- **Statement deposits ↔ bank credits**: not something the site matches. The bank line matches the batch
  receipt instead (section 1). Measured by hand above: 25 of 25.

### 7 · Duplication

| # | rehearsal | result |
|---|---|---|
| 3 | the same statement forwarded again | **refused**, 1 bill |
| 5 | **the month's fees typed on Spending first, then the statement** | **booked again — accrual August card fees $9,557.46**, twice $4,778.73 |
| — | a corrected re-issue with different fees (synthetic) | not booked; says the bill on file differs and to look at both |

### Gaps for this feed

**G-CSTMT-1. Fees typed on Spending, as the monthly account invites, are counted twice when the statement arrives.**
OBSERVATION: rehearsal 5, real fees: $4,778.73 typed on Spending, then the statement → **$9,557.46** of
August card fees. The statement's duplicate check looks only for its own bill number
(`card-statement-store.ts` 48). Until a statement is read, the account lists *"Card processing and bank fees
— … nobody sends an invoice for it"* (`profit-and-loss.ts` 579) under *"Record them on Spending"*
(`money/monthly/page.tsx` 127).
SHOULD BE: one month's fees are one expense, and the site's own instruction is never the step that doubles
money. The processor does send a monthly statement, so "nobody sends an invoice for it" is no longer true.
DIFFERENCE: yes, rehearsed. $4,778.73 in a month like August. Live: measured-and-none.
Owner: `profit-and-loss.ts` and `money/**` — **A**; `card-statement-store.ts` — **1** (built it).
Proposed fix:
(a) the absent-fees line says the fees come with the processor's statement after month end, to forward
and not to type;
(b) `bookCardStatement` holds, naming the bill, when a confirmed bill in that category dated in the
statement month has the same amount or a Global Payments / Heartland vendor.

**G-CSTMT-2. The batch check names a neighbouring month's batch as "matching no deposit".**
OBSERVATION: rehearsal 2. July's real last deposit ($3,695.38, a batch closed 7/30, on July's statement)
was on file, and the August check reported *"1 batch report on file for these dates matches no deposit."*
The statement is organised by deposit date, so its first batch closed on the last day of the previous
month (7/31). The receipt window starts a day before that (`card-statement-store.ts` 104), so the previous
month's last batch falls inside it. The same happens at the other end whenever a batch closes the day after
the statement's last batch date.
SHOULD BE: a check that fires on a correct month teaches its reader to ignore it, including the month it is right.
DIFFERENCE: yes, rehearsed with real structure. It will say it every month the previous month's last batch is on file.
Owner: `card-statement-store.ts` — **1**.
Proposed fix: count as extra only receipts no adjacent statement could hold. The simplest version: drop the
±1 widening from the extra count, and keep it for matching.

**G-CSTMT-3. The fees count in the wrong cash month until the bank statement is read, and permanently if the bank statement is read first.**
OBSERVATION: the bill is paid on the printed debit date, the month's last day. **Measured: the money leaves
the following month** — July's on 3 August, and August's not in August. Rehearsed: August's fees sit on
August's cash account until the bank line moves them to September. If the bank statement is read before the
card statement, the debit line is unplaced. Bank lines are kept by key and never re-placed (`bank.ts` 78),
so the bill keeps the printed date for good.
SHOULD BE: on the cash basis an expense is recorded on the day the money left the bank.
DIFFERENCE: yes. **$4,778.73 in the wrong cash month** for August's statement: every month, temporarily, and
permanently in the bank-first order.
Owner: `card-statement-store.ts` — **1**; `money/bank.ts` — **A**.
Proposed fix: (a) book the bill unpaid (`paidOn` null, "taken by auto-debit; the bank statement dates it");
(b) when a `GP-…` bill is booked, link any unplaced Heartland fee debit of exactly its amount and take its
date. Trade-off: with (a), a month whose bank statement is never read shows no cash fees at all. The account
already lists absent costs, so it would be visible.

**G-CSTMT-4. August's card fees, $4,778.73, leave the bank in September and are on no account.**
OBSERVATION: rehearsal 1, the August statement books nothing (before the books). The bank shows the fees
leaving the next month. When September's bank statement is read, that debit is unplaced and says to
forward the statement. Forwarded, the statement books nothing, so the line can never clear. Rehearsal 4
shows the same shape with July's $5,183.71.
SHOULD BE: an instruction on screen can be completed. **Whether September's cash account should carry
August's fees can't be written from domain knowledge alone** → Q-CSTMT-1.
DIFFERENCE: the instruction, yes. The money waits on the owner.
Owner: `card-statement-store.ts` — **1**; `bank-statement.ts` message — not in the table.

**M-CSTMT-1 (money, for the owner — not a data fault). August's card processing cost 5.06% of card deposits.**
OBSERVATION, from the real statement:
- **Global Payments' own charges, $2,908.17**:
  - a **2.15% discount rate** on all card volume (Visa $1,324.68, Mastercard $542.02, Discover $130.25,
    Amex $38.65);
  - **$0.3164 per transaction** (Visa $552.71, Mastercard $224.99, Discover $27.86, Amex $14.56);
  - $18.95 "monthly vs daily discount cost";
  - $33.50 "service & regulatory mandate".
- On top of those, **$1,870.56** of card-network interchange and assessments passed through at cost.
- 2,430 transactions, average $38.96.

SHOULD BE: on pass-through ("interchange-plus") pricing, interchange is the unavoidable part and the
processor's markup is the negotiable part. For a retail merchant turning about $95,000 a month, markups are
commonly quoted in tenths of a per cent plus a few cents a transaction. A 2.15% markup plus 32 cents is well
above that. This is industry pricing, not a figure the site holds, so it is offered as a reason to get quotes,
not as a finding.
DIFFERENCE: illustratively, at a 0.50% + $0.10 markup August's processor charges would have been about $716
rather than $2,908.17 — **about $2,190 a month, $26,000 a year**. That is illustrative, not a quote. Whether
the contract has a term or an early-termination fee is unknown.

**Q-CSTMT-1 (question for the owner).** Global Payments takes each month's card fees from the bank early the
following month. August's $4,778.73 left in September, after the books began on 1 September, for a month
before them. Should September's cash account carry them? Money received before 1 September is kept out
because it arrived before the books; this left after they began. Today it is on no account.

### Not checked, said out loud

- The bank statement through any site reader: none exists for a scanned PDF (session 1 has asked the owner
  about a CSV). Its Heartland lines were transcribed by eye, and a misread digit would show as an unmatched
  row. None did.
- The batch report's close date against the statement's batch date for the same batch: no August batch
  reports are on file. The ±1 day allowance is untested on real pairs until September's statement meets
  September's reports.
- More than one merchant account: the statement shows one (…4875) and the bank shows one Heartland
  reference. Not asked.
- July's card statement: not on file. The attribution of the 3 August $5,183.71 debit to July's fees rests
  on its being the only Heartland debit in August and on the pattern August's own fees follow.
- The year-on rehearsal changes only the year. Weekdays in 2027 differ, and no code reads them.

---

## 3. ProviderPay payer payment report and the Health Mart Atlas EFT notice — rehearsed

**Checkpoint 3. Code at c898bb4. Samples, from the owner's uploads:**
- the real ProviderPay payer payment reports for **1–31 August** (44 payments) and **1–9 September** (12);
- the real August bank statement's **20 Access Health and 15 ProviderPay credits**, read by eye as in section 2.

Rehearsed on a fresh snapshot (17:08 UTC). No real EFT notice text was used: stored notices are under
`data/`. The notice was built in the layout the reader's header quotes, carrying a real EFT number, amount
and date from the September report.

### 1 · What they are, who sends them, how often, through which door

- **Payer payment report** (CSV from the ProviderPay portal): one row per payment into the pharmacy's
  ProviderPay arrangement — payer, payment number, deposit date, payment date, amount, type, and match
  columns. Forwarded by staff, a date range each time.
  Door: mailbox sweep → `classify` by header → `payer_payments` → `importPayerPayments` (`mailbox.ts` 997).
  **Rehearsed: both real reports classify `payer_payments`.**
- **Health Mart Atlas "EFT completed" email**, daily, no attachment: the EFT number, the NCPDP, the
  amount, and the plans inside it. Door: the no-attachment branch of the sweep → `bankEftNotice`
  (`mailbox.ts` ~487). **Live: 2 received and banked** (11 and 14 September).

**What the rows are, measured against the bank** (August):
- the **20 "Health Mart Atlas" payments** (type COPY, number `EFT-…`) equal the **20 "ACCESS HEALTH/ACCESS HEA"
  bank credits** to the cent, one to one;
- the **24 direct-payer payments** (Argus, Express Scripts, DomaniRx, Tricare, Medicare-dual, RxCrossroads;
  type EFT) total **$135,053.52**, exactly the **15 "ProviderPay/EDI PYMNTS" credits**. They are singles or
  daily sweeps of 2, 3 and once 4 payments. On 8/26, four payments made $12,330.61 (session 1's example).

### 2 · Recognised automatically? Malformed or lookalike — loud or silent?

- Report: recognised by four header columns together (payment number, payer name, deposit date, payment
  amt). A row without a number, payer, readable date or readable amount is skipped with its row and reason.
  **Rehearsed: August skips 1 row, "the payment is zero"; September skips none.**
- Notice: subject *"Health Mart Atlas EFT completed"* and the sentence *"electronic funds transfer for m/d/yyyy
  is complete"* both required. **Rehearsed: a notice for another NCPDP is refused and says so.**

### 3 · Read correctly?

**August: 44 payments, $510,990.21. September 1–9: 12, $168,943.43.** Payer names as printed.
- **The independent check is the bank:** every HMA payment and the direct-payer total agree with the August
  bank statement to the cent (section 3 · 1).
- Amounts are parsed as text (`moneyCents`), so no float cent loss. Every figure agreed to the cent.

**The report's "Deposit date" is not the bank's date for HMA payments.** Bank date minus report date:
0 days ×13, +2 ×4 (Saturday report dates, credited Monday), −2 ×2, and **−6 ×1** ($15,041.00: report 8/26,
bank 8/20). For the direct payers the report date is the bank date.

### 4 · Where it lands, and which date decides the month

Each payment is one `cash_receipts` row: kind `third_party`, payer as printed, `receivedOn` = the report's
deposit date (or the notice's transfer date), month from that. `outOfBooks` comes from `receivedOn`.
**Rehearsed: August's 43 banked rows are all out of books; September's are in.** Key
`payer-payment|<payer lowercased>|<payment number>`, shared by the report and the notice.

### 5 · Which basis reads it

Cash only, as `third_party` receipts. The accrual account never reads cash receipts (it reads claims). So
once on cash and never on accrual, by the same code path as section 1 · 5. This checkpoint did not re-run
`monthlyAccount`.

### 6 · What it matches to

- **Report ↔ notice**: the shared key. Rehearsed below.
- **Receipt ↔ bank line**: `matchHeldDeposit` — exact cents, ±7 days, one to one, and combinations of 2–3
  since 6ad1c04. **Rehearsed on the real August bank lines** (reproducing `bank.ts` 88–150):

| bank lines | result |
|---|---|
| 20 Access Health, $375,936.69 | **20 confirm** the HMA receipts. All inside the ±7 days, the −6-day one included |
| 9 ProviderPay singles, $78,193.25 | 9 confirm |
| 5 ProviderPay sweeps of 2 or 3, $44,529.66 | ambiguous, named, **nothing banked** |
| 1 ProviderPay sweep of 4 (8/26), $12,330.61 | unplaced, nothing banked (session 1 is extending the search past 3) |
| confirmed against the wrong feed's receipt | **none** |

Nothing was banked twice from the bank. The six sweep lines stay on the unplaced list, and their money is
already on file.

### 7 · Duplication

| # | rehearsal | result |
|---|---|---|
| 1 | August report, first arrival | **43 banked, 1 refused** — see G-PP-1 |
| 2 | August report again | 0 banked, 43 already held |
| 3 | September 1–9 report again (already live) | 0 banked, 12 already held |
| 4a | report first, then the notice for the same EFT | *"1 already on file under its EFT number, so not banked again"* |
| 4b | a notice a dollar different from the held figure | kept the held figure; *"one of the two is wrong"* |
| 4c | notice first (dated 9/5), then the report (dated 9/8) | 1 receipt, **dated 9/5 — the first arrival's date is kept** |
| 4d | another store's NCPDP | refused, named |

### Gaps for this feed

**G-PP-1. A payer's second payment of the same amount within seven days is refused as a duplicate, so real money is not counted. — FIXED, 882307e (pushed, not deployed at the re-run).**
Re-run on a fresh snapshot (17:29 UTC): August report **44 banked, $510,990.21, 0 refused**; again, 44 already
held. On the August bank lines, the 8/28 $904.00 line now names both $904 receipts rather than confirming
the wrong one. Nothing banked. **The live database still holds 5 DomaniRx August receipts.** August is out of
books, so no account is affected; re-reading the report after the deploy would bank the sixth.
OBSERVATION: rehearsal 1. The real August report holds two DomaniRx payments of **$904.00**: payment …4538
deposited 8/26 and payment …2227 deposited 8/28, with different payment numbers. The second was refused:
*"904.00 from DOMANIRX on 2026-08-28 is already banked as …4538 under 2026-08-26"*. **The live database shows
the same: 5 DomaniRx receipts for August, $10,780.08, against the report's 6, $11,684.08.** The cause is
`gateDeposit`'s cross-feed rule (`deposit-gate.ts` 133–137): same amount, within 7 days, and the same payer
head. It is applied even when both receipts carry different payment numbers from the same feed. The real bank
statement shows both: $904.00 inside the 8/26 sweep and $904.00 alone on 8/28. The 8/28 bank line then
confirms the 8/26 receipt, so **the bank reconciliation looks clean while the cash account is $904.00 short.**
SHOULD BE: a payer's own payment number is unique to the payment. Two payments with different numbers from
the same payer are two sums of money, however alike their amounts. Repeat identical amounts are ordinary for a
payer paying a fixed fee or a recurring claim.
DIFFERENCE: yes, rehearsed and live. **$904.00 in August** (out of books, so no current account moved). The
same rule runs on every in-books month. September 1–9 had no such pair; later September reports were not
among the samples.
Owner: `deposit-gate.ts` — **1**.
Proposed fix: in `gateDeposit`, when the incoming receipt and the held one both carry a reference of 6+ digits
**from the same feed** (same source-key prefix) and the references differ, they are different money: skip the
amount rule for that pair. Keep the amount rule across feeds, where one deposit really does carry different
references (an 835 trace against a portal payment number).

**G-PP-2. A deposit's date and month are whichever document arrived first.**
OBSERVATION: rehearsal 4c. The notice (dated 9/5) banked first and the report (9/8) was then recognised by key;
the receipt kept 9/5. In the other order it would carry 9/8. Measured in August: the report's own deposit date
differs from the bank by −6 to +2 days. How the notice's transfer date relates to the report's deposit date for
the same EFT is **never-measured** (no real notice and report cover the same EFT among the samples; the
reader's header says the same).
SHOULD BE: a receipt's date does not depend on reading order. On the cash basis the date that decides the month
is when the money reached the bank, and neither document is the bank.
DIFFERENCE: only when the two dates straddle a month end. None in August's sample. Dollars: one HMA deposit
per occurrence (August's ranged $1,119.93–$40,084.14).
Owner: `payer-payments-store.ts` / `health-mart-eft-store.ts` — **not in the ownership table**;
`money/bank.ts` — **A**.
Proposed fix: when the bank line confirms a receipt, move `receivedOn` and `month` to the bank date. The bank
statement becomes the date authority on cash, as it already is for the card fee bill (section 2 · 5). Until a
bank statement is read, the first arrival stands.

**G-PP-3. ProviderPay sweeps stay on the unplaced list though their money is on file.**
OBSERVATION: 6 of August's 15 ProviderPay lines, $56,860.27, are combinations. Five are named as ambiguous
("those receipts are this money"); the 4-payment sweep is unplaced. None is linked to its receipts, and none
ever clears (G-CARD-12's shape).
SHOULD BE: a line whose money is fully accounted for leaves the work list.
DIFFERENCE: not a money error; list noise, every month.
Owner: session 1 is building the ProviderPay account reader and the wider combination search.
Proposed: when the combination is unique and exact, link the bank line to all its receipts and mark it placed.

### Not checked, said out loud

- A real EFT notice's text: the reader's quoted layout was used. The two live notices were read and banked by
  the site on 15 September, but their stored text is under `data/`.
- The notice's transfer date against the report's deposit date for one EFT (G-PP-2).
- September reports after the 9th: live receipts to 9/10 came from a report not among the samples.
- The report's match columns (remit match, claim match, no-claim match, adjustments): stored, read by nothing.
  They are the 835 checkpoint's.
- The ProviderPay holding account's own history (Wells Fargo CSV): no reader yet (session 1).
- The recoupment debit on the bank statement (`SHA PROVIDERPAY/AUTO ACH`, $635.58 on 8/25): the recoupments
  checkpoint.

---

## 4. Plan 835 remittances (ProviderPay) — what could be rehearsed without a file

**Checkpoint 4. Code at 882307e. The owner approved, 15 September, read-only access for the audit's scripts to
stored files under `data/`, printing aggregates only.**

**Samples: no real plan 835 file is kept anywhere the site stores files.** A script read the first 400 bytes of
every file under `data/remits`, `data/remittances` and `data/files` (the document store, 360 files):
- 14 files declare an 835;
- 12 are the Medicare Transaction Facilitator's, in `data/remits/mtf/filed` (section 5's);
- one is a test file ("TEST PAYER INC", $24.68);
- one reads as nothing.

The 9,550 plan payment rows in the database were read from files that were not kept: April by "Folder read",
August by the owner. No row links a document. **So `parse835` and `importRemittance` could not be rehearsed
on a real ProviderPay 835.** Session 1 is finding one with the owner. What the posted rows themselves can
prove is below.

### What is on file (live, read-only)

| month | 835 rows | payer on every row | paid | out of books |
|---|---:|---|---:|---|
| April | 4,867 | "ProviderPay" | $381,341.52 | yes (test pull) |
| August | 4,683 | "ProviderPay" | $518,125.46 | yes |

- 90 distinct trace numbers: 40 shaped `EFT-…`, 50 plain numbers.
- No cash receipt was banked from any 835 (none keyed `835|…`). Every door used so far posts without banking:
  the folder read and the `/remits` page. The **mailbox** (email and the SFTP host) and the **intake drop**
  call `importRemittance(…, { bank: true })`.

### 1 · What it is, and whose money

A ProviderPay 835 names **ProviderPay** as the payer (N1*PR) on every remittance, for money that reaches the bank
two ways (section 3):
- **Health Mart Atlas** deposits. The 835's trace is the `EFT-…` number. **All 20 August `EFT-…` traces equal an
  HMA payment number in the payer payment report** (18 of 19 in April).
- **Direct-payer** deposits. The 835's trace is a plain number that equals **no** payment number in the report.
  **In August, 15 of them sum exactly to a direct-payer payment in the report within 7 days** (Argus, Tricare,
  Medicare-dual, RxCrossroads, DomaniRx). The other 13 sum to no report payment.

### 5 · Which basis reads it

- A plan 835 posts `claim_payments` with `revenueCents` 0 (`settles`): the claim already carries its
  remittance, so the accrual account is not moved.
- It reaches the cash account only through the receipt a banking door adds. Both halves by the code
  (`claim-payments.ts` 473–545).

### 7 · Duplication — rehearsed with the real posted remittances

Each August remittance was rebuilt from its own posted rows: trace, payer "ProviderPay", paid date, and the sum of
its payments. It was banked on a fresh snapshot (17:34 UTC) with exactly the arguments `importOneRemittance`
passes when `bank` is on (`claim-payments.ts` 546–572), through the real `addCashReceipt` and `gateDeposit`.

| the August 835 remittance | gate | count | dollars |
|---|---|---:|---:|
| trace = an HMA payment number | **refused** (reference rule) | 20 | $321,723.80 |
| amount = a direct-payer payment in the report, within 7 days | **banked beside it** | 15 | **$148,965.45** |
| amount and number match nothing in the report | banked | 13 | $47,436.21 |
| the same remittance read a second time | refused by its key | — | — |

One approximation, said out loud: the real code banks BPR02, the remittance total. The rows give the sum of
claim payments, which equals BPR02 only where nothing was held back at remittance level. For the 15, the sums
equal the deposit to the cent, which is that case.

### Gaps for this feed

**G-835-1. A ProviderPay 835 for a direct payer, arriving by mail, SFTP or the intake drop, banks the deposit a second time. — FIXED, d477ee4 (deployed).**
Re-run on a fresh snapshot (17:49 UTC), in two parts.
- **The door:** the real `importRemittance` with banking on, fed the one non-MTF 835 kept (the site's test
  file) with its payer renamed in memory and its own trace each run. "ProviderPay": posted 2, **not banked**.
  "MEDICARE TRANSACTION FACILITATOR": posted 2, **not banked**. A control, "SOME OTHER PLAN": posted 2,
  **banked**, so the test can tell the difference.
- **The gate's belt,** rebuilding August's 48 remittances as before and banking them straight through
  `addCashReceipt`: the 15 amount-matched are now **refused** ($148,965.45), and so are the 20 HMA by
  number. The 13 with no match would still pass the gate, but through the real door a ProviderPay 835 never
  reaches it.

Banked beside a report receipt: **$0.00**.
The finding as first recorded:
OBSERVATION: rehearsed with August's real posted remittances. 15 direct-payer remittances, **$148,965.45**, were
banked beside the payer payment report's receipts for the same money.
- The 835 names the payer "ProviderPay"; the report names "ARGUS HEALTH SYS" and the rest.
- The 835's trace differs from the report's payment number.
- `gateDeposit`'s cross-feed rule needs a matching reference, or the same amount with the same payer head
  (`deposit-gate.ts` 133–150), so it sees two different payers.

The other 13 ($47,436.21) bank too. Whether they are the same money as report payments of different amounts
is not proven. The reverse order (835 first, report second) meets the same rule, by the code; it was not run.
SHOULD BE: an 835 is the advice of a payment, not the payment. The deposit is recorded once, by the document that
records deposits: here the payer payment report and the EFT notice. A remittance advice arriving later adds
claim detail, never cash.
DIFFERENCE: yes, rehearsed. Had August's 835s come in through the mailbox, **$148,965.45 of receipts would have
been counted twice**. The matching report payments were deposited in August and early September, and the
September ones are in the books. The same would happen every month once ProviderPay 835s arrive by SFTP or
email. Live: measured-and-none so far (no 835 has come through a banking door).
Owner: `claim-payments.ts` — **not in the ownership table**; `mailbox.ts` routing — **B**; `deposit-gate.ts` — **1**.
Proposed fix: (a) an 835 whose payer is the PSAO (ProviderPay) posts its claim payments and **does not bank**,
because the report and the notice are the banking doors for that money; (b) belt and braces in the gate: an `835|…`
receipt with no reference match is compared by amount within the window **without** the payer-head condition,
and a match goes to a person.

**G-835-2. 835 claim payments and the deposits they belong to do not add up, and nothing says by how much.**
OBSERVATION: of August's 20 HMA remittances, whose trace equals the deposit's EFT number, the summed claim
payments equal the deposit for **2**. For the other 18 they differ. (April: 1 of 18.) The 20 remittances' payments
total **$321,723.80**; the 20 deposits their traces name total **$336,229.96** (deposited in August and
September).
SHOULD BE: a deposit is its claim payments less what the payer held back at remittance level. Each difference is
money with a reason (fees, DIR, recoupments, or claims paid on another advice), and it belongs on an account
or a list.
DIFFERENCE: **$14,506.16** between those 20 remittances' claim payments and their deposits, the deposits being
larger, explained nowhere on the site. It is a net figure: 18 remittances differ, in directions not measured
here. It can't be classified without the files: the remittance-level adjustments (PLB) were not stored
with the rows, and whether some deposits are split across several 835 files is not known.
Owner: `claim-payments.ts` — not in the table; the reconciliation plan in `docs/ASSIGNMENTS.md` ("claim → 835
line → deposit").
Proposed: when a real 835 sample is in hand, rehearse `importRemittance` and store the provider-level adjustments
per remittance, so this difference can be read rather than derived.

### Not checked, said out loud

- `parse835`, `importRemittance`, `payableOnly`, the balance check and the claim matching, on a real ProviderPay
  file: no file.
- April's pull is test data (out of books) and was not rehearsed beyond the trace counts.
- Whether ProviderPay will send 835s by SFTP or email at all: the SFTP folder holds a key pair from 9 September
  (not opened). What it fetches was not checked.

---

## 5. Medicare Transaction Facilitator (MTF) payments — rehearsed

**Checkpoint 5. Code at 882307e.** Samples:
- **the 12 real MTF 835 files** kept in `data/remits/mtf/filed`, paid 18 August to 10 September (read-only,
  owner-approved);
- the August bank statement's 14 "MTF PM NGS/MTF PMT" credits (read by eye, section 2).

Rehearsed on a fresh snapshot (17:39 UTC).

### 1 · What it is, who sends it, through which door

The Medicare Transaction Facilitator pays the Part D negotiated-price difference on Medicare claims, as an 835
per payment day. Door: the MTF CLI downloads into `data/remits/mtf`, and the facilitator sweep reads it with
`importRemittance` **without banking**. The same file arriving by email or the intake drop is read with banking
on (section 4).

### 3 · Read correctly?

All 12 real files parse and **every one balances**: 25 payment lines, BPR total $5,856.77.
- One file (24 August) pays $0.00: a payment and its reversal.
- The 8 August files total **$5,541.37 — exactly the live August MTF rows.**
- **Against the bank: every August MTF 835 with money (7) equals an MTF bank credit to the cent, on the same
  day.** The bank's 7 earlier MTF credits (3–14 August, $4,791.21) have no file; the CLI's first download is
  18 August.

### 4–5 · Where it lands, and which basis reads it

- `claim_payments`, source `mtf`, `revenueCents` = the payment. The facilitator pays on top of the plan, so it
  is new revenue.
- **Cash account:** where the month has **no** facilitator cash receipt, the MTF payments received in the month
  stand in as the facilitator line (`profit-and-loss.ts` 1003–1006). Where it has **any**, only the receipts count.
  **Live September cash facilitator line: $2,789.08 = the September MTF rows exactly.**
- Two September rows ($193.78) have no revenue figure. The account falls back to the payment, so cash is right.
- A bank statement places an MTF credit as `deposit/facilitator` and banks it (`bank-statement.ts` FACILITATOR
  rule): no receipt exists for it to confirm.

### 7 · Duplication and completeness

| # | rehearsal | September cash facilitator line |
|---|---|---|
| — | as live | $2,789.08 |
| 1 | the sweep re-reads all 12 real files | posted 0, 25 already held; unchanged |
| 2 | the real 8 September file ($5.36) arrives first through a banking door (intake or email) | **$5.36** |
| 3 | a bank export for 1–12 September carries the five MTF credits of those days ($1,232.94) | **$1,232.94** |

### Gaps for this feed

**G-MTF-1. One facilitator receipt replaces the whole month's facilitator money on the cash account. — (b) FIXED in d477ee4; (a) OPEN, A's.**
Re-run on a fresh snapshot (17:49 UTC), with the bank reproduction following d477ee4 (facilitator-paid
context):
- the real 8 September MTF file through a banking door: posted 1, **not banked**; September line stays **$2,789.08**;
- the mid-month bank export: all 5 MTF credits placed **already counted**, nothing banked; line stays **$2,789.08**.

What remains is (a), the all-or-nothing stand-in in `profit-and-loss.ts`, owned by **A**. **Nothing banks a
facilitator receipt automatically any more**, so only a facilitator receipt typed by hand on `/money` can
still trigger it. It is open against A.
The finding as first recorded:
OBSERVATION: the account uses MTF payments only while the month holds no facilitator receipt, all or nothing
(`profit-and-loss.ts` 1003). Rehearsed on September's real money:
- **one MTF 835 through a banking door** made the line $5.36 instead of $2,789.08, **$2,783.72 short, with
  nothing to correct it**;
- **a bank export to 12 September** made it $1,232.94, **$1,556.14 short** until a later statement banks the rest.

The account does not say which source it used.
SHOULD BE: each facilitator dollar counts once on the cash account, from whichever record holds it. A second
record of some of the money must not remove the rest.
DIFFERENCE: yes, rehearsed. The first case is reachable by forwarding one MTF 835 by email. The second by
reading any bank statement that ends before the month does, and a statement read on the day it is exported
always ends before the month does.
Owner: `profit-and-loss.ts` — **A**; `claim-payments.ts` (banking an MTF 835 at all) — not in the table.
Proposed fix: (a) replace all-or-nothing with per payment. An MTF payment stands in unless a facilitator receipt
holds it: the same trace (for an 835-banked receipt), or the same cents on the same day (for a bank line;
August, 7 of 7). (b) An MTF 835 never banks, whatever door it comes through, since its money is already on
the account through the stand-in. The same principle as G-835-1.

**G-MTF-2. An MTF bank credit with no remittance for its day can confirm another payer's receipt. — FIXED, 7b71c14 (deployed).**
Re-run (17:57 UTC): the $123.45 MTF credit is placed `facilitator_unmatched`, is not matched, and the HMA receipt
of $123.45 stays unclaimed.
The finding as first recorded:
OBSERVATION: at d477ee4, an MTF credit whose day's remittances do not equal it is placed `unplaced`, and
`bank.ts` then matches every unplaced credit against all receipts in the window. Rehearsed: an MTF credit of
$123.45 on 9/17, with no MTF remittance that day, **confirmed a Health Mart Atlas receipt of $123.45 from 9/16**.
The real HMA bank line would then find its receipt claimed and stay unplaced. Money: $0.00 over. Links: both
wrong.
SHOULD BE: a credit the site has identified as the facilitator's is evidence about facilitator money only, as
a card deposit is about card batches (G-CARD-11).
DIFFERENCE: yes, rehearsed. It needs the same cents within 7 days. The case that reaches it is the facilitator
credits with no file (August had 7 before the CLI started).
Owner: `money/bank.ts` — **A**; `bank-statement.ts` — not in the table.
Proposed fix: return a facilitator-specific kind from `placeLine`, and skip the receipt match for it, as
56f0ce2 does for `card_deposit`.

### Not checked, said out loud

- The CLI download itself, and whether the filed folder holds every remittance: September's rows on 11, 14 and
  15 September have no file in the filed folder. They were posted by the automatic check from a folder not
  examined here.
- Facilitator money on the accrual account: all MTF rows are unmatched to claims (their fills are July and
  August, before the books). The accrual side waits for fills inside the books.

---

## 6. McKesson: Accounts Payable report, Returns Details, and their invoices — rehearsed

**Checkpoint 6. Code at 7f89689.** Samples, read-only from the document store (owner-approved):
- **the real Accounts Payable Open & Closed Transactions report** received 11 September;
- **the real Returns Details report** received 15 September.

Rehearsed on a fresh snapshot (17:46 UTC). Note: session 2 built the invoice reader. This section audits the
feeds around it and does not re-prove that reader.

### 1 · What they are, who sends them, how often, through which door

From era@mckesson.com as zipped CSVs:
- the AP report, **weekly** (one received so far);
- the Returns Details, **daily** (five received, 11–15 September);
- two totals sheets beside each, recognised and deliberately not read.

Door: mailbox → `classify` by header → `ap_transactions` / `mck_returns` → `fileApTransactions` /
`fileReturnCredits` (`mailbox.ts` 1086–1109). **Neither books a cost.** The AP report is McKesson's own ledger:
when each invoice is due, whether it cleared, and the ACH it cleared under.

### 3 · Read correctly?

**AP report:** 63 rows, 0 unreadable, 0 without a due date.
- 27 "Closed – Cleared", all under **one ACH, …7740, cleared 7 September, $106,322.62**;
- 36 "Open – Pending Approval", all due 15 September, $141,857.92;
- every row's gross less its 2% discount equals its net (the reader refuses otherwise); discounts total $5,064.91.

**Independent check against the invoices the site read from McKesson's PDFs: 21 on both agree to the cent, 0
differ.** The other 42 ($142,036.21) are on the report with no invoice on file, and all 42 are in PioneerRx's
receiving record.

**Returns Details:** 67 items, 0 unreadable, 9 credit notes, **−$10,411.15**, all "Saleable Return". Handling
$58.80. 66 of 67 name the invoice the goods were bought on.

### 4 · Where it lands

`supplier_statement_lines`, keyed supplier + number + due date. Credits go in the same table, negative, with
status "Credited".

### 5 · Which basis reads it

**Cash cost of goods only** (`cash-cogs.ts`). McKesson is "covered", so its cash cost is exactly its cleared
lines, by clearing month, and nothing from its invoice dates or receiving. Supplier names fold to one key in all
three tables ("Mckesson" / "McKesson"), so coverage holds. Other suppliers (IPC, IPD, ParMed, Anda, JamsRX,
Xymogen) are counted from invoice dates and receiving, and the account names them.
`countedTwiceInCash` for September: **0 rows**. The accrual account does not read this table.

### 6–7 · Matching and duplication

| # | rehearsal | result |
|---|---|---|
| 1 | the AP report re-filed | 0 new, 63 updated; lines 72 → 72 |
| 1 | the returns report re-filed | 0 new, 9 updated (live: five daily copies, each "already held") |
| 2 | next week's report moves one open invoice's due date (…5034, $22,118.56) | **a second row**; after it clears, the old open row stays |
| 4 | the real ACH debit of $106,322.62 read from a bank statement, **as `bank.ts` builds the context** | **unplaced** — *"names Mckesson but no open invoice of theirs is for this amount"* |
| 4 | the same debit **with the ledger supplied** | `settles_ach` — *"covers 27 Mckesson invoices and comes to exactly this debit"* |

### Gaps for this feed

**G-MCK-1. The McKesson ACH tie is built and never runs: a real bank read leaves every McKesson debit unplaced and every McKesson invoice unpaid. — FIXED, 7b71c14 (deployed).**
Re-run on fresh snapshots (17:57 UTC), reproducing `bank.ts` at 7b71c14:
- the real $106,322.62 debit → `settles_ach`, agrees, covers 27 invoices. **0 marked paid, because none of that
  ACH's 27 invoices is on file** (the 27 McKesson invoices on file are later ones);
- a debit a dollar short → recorded unplaced: *"coming to 106322.62, and the bank took 106321.62 — worth a look"*;
- **next week's report, simulated** by clearing the 36 real open rows ($141,857.92) under one ACH: the matching
  debit → `settles_ach`, agrees, **21 of the 21 invoices on file marked paid** on the bank date; a dollar short
  → unplaced.

The finding as first recorded:
OBSERVATION:
- `placeLine` ties a McKesson debit to the invoices inside it only when its context carries the AP ledger
  (`bank-statement.ts` 229, `ctx.settled`). `matchContext` in `bank.ts` (21–47) never supplies it.
- Rehearsed with the real ACH: unplaced as `bank.ts` runs; `settles_ach` to the cent with the ledger.
- Even when placed, `bank.ts` has no branch for `settles_ach` (the `else` at 170 counts it as not placed) and
  marks none of its invoices paid.
- **Live: 27 of 27 McKesson invoices on file have no paid date.**

August's bank statement carries four such debits ($500,597.61).
SHOULD BE: the wholesaler's own ledger, the ACH reference and the bank debit are three records of one payment,
and reading the bank statement should join them, which is what the rule was written to do.
DIFFERENCE: yes, rehearsed. Not a double count: cash cost comes from the ledger either way. But the largest
debits on every statement stay on the unplaced list, and no McKesson invoice is ever shown paid.
Owner: `money/bank.ts` — **A**; session 1's matching engine (item 2 on its queue) is the natural home.
Proposed fix: pass `settled` from `supplier_statement_lines` in `matchContext`; add a `settles_ach` branch that
records the line as placed and stamps `paidOn` on the covered invoices.

**G-MCK-2. Return credits, $10,411.15 so far, reach neither account.**
OBSERVATION: credits are filed with status "Credited" and no clearing date. Cash cost of goods counts only
cleared lines, so they never reduce it. The AP report carries no credit rows. The 7 September ACH equals its
27 invoices exactly, though 6 credit notes ($8,526.77) were already on McKesson's returns report by
11 September. So those credits were not taken off that debit.
SHOULD BE: a wholesaler credit is money back when the wholesaler applies it: netted from a later payment,
listed as a credit on the account, or refunded. The cash account records it then.
**How McKesson applies these credits cannot be written from the data held → Q-MCK-1.**
DIFFERENCE: waits on the answer. The code has no path from "Credited" to any account, whatever the answer.
Owner: `ap-transactions.ts`, `cash-cogs.ts` — not in the ownership table.

**G-MCK-3. A changed due date leaves a paid invoice looking unpaid.**
OBSERVATION: rehearsal 2. The ledger key includes the due date, so an invoice re-reported with a new due date
becomes a second row. The old "Open" row is never updated, and after the new row clears, "not yet taken"
still counts **$22,118.56** that was paid. `countedTwiceInCash` does not see it: it checks cleared money only.
SHOULD BE: one invoice is one ledger line whose status moves; a payable already paid is not owed.
DIFFERENCE: in code, rehearsed. Whether McKesson ever moves a due date: never-measured (one report so far).
Owner: `ap-transactions.ts` — not in the table.
Proposed fix: key on supplier + invoice number (+ transaction type), and update the due date in place.

**G-MCK-4 (wording). After a bank read, "N not placed" counts lines that were placed.**
`bank.ts` 170 adds every `already_counted`, `own_transfer`, `confirms_standing` and `settles_ach` line to the
"not placed" number in the message. The list on the page (`lastStatementLines`) is right, because it reads
the recorded placement. Owner: `money/bank.ts` — A.

**Q-MCK-1 (question for the owner).** When McKesson credits a return, how does the money come back? Is it taken
off a weekly ACH, shown as a credit on the Accounts Payable report, or paid out separately? $10,411.15 of
saleable-return credits have been issued since 19 August.

### Not checked, said out loud

- McKesson's September bank debit for ACH …7740: no September bank statement. The tie above is rehearsed
  against the real ledger, not a real bank line; August's debits have no AP report beside them.
- The invoice PDFs themselves: the 21-of-21 agreement is the check used here.
- The weekly transition from open to cleared on a second real report: only one AP report exists.
- Cash cost of goods for September as a total was not recomputed this checkpoint.

---

## 7. PioneerRx "System Sales Totals By Payment Type" — rehearsed

**Checkpoint 7. Code at 8394955 (reader and store).** Sample: **the owner's real report for 30–31 August 2026**,
printed 15 September. Rehearsed on a fresh snapshot.

### 1–2 · What it is, door, recognition

The till's own split of a period's takings by how they were paid (cash, cheque, card, account, coupons, and a
returns column for each), by section: front shop, prescription customer payments, plan remit, and adjustments.
Sent daily by the owner. Door: mailbox → `classify` → `sales_by_payment` → `fileSalesByPayment`.
**Rehearsed: the real file classifies `sales_by_payment`.** Recognition is by its title in the first 2,000
characters. A report missing any of the nine payment columns, Totals or Tax Collected is refused, naming the
column.

### 3 · Read correctly? Could the checks pass for the wrong reason?

| figure (30–31 Aug) | read |
|---|---|
| cards | $3,768.82 less $181.23 refunded = **$3,587.59** |
| cash / cheques / accounts / coupons | $56.46 / $34.39 / $0.00 / $0.00 |
| prescriptions | patients $3,426.89, plans $43,919.34 |
| front shop | $234.00 plus $17.55 sales tax |
| total | $47,580.23 |

- Every row's payments equal its total plus tax.
- Every section's rows equal its printed totals row.
- **All payment columns ($3,678.44) = total − plan remit + tax, to the cent.**
- **A copy with one figure raised by $1.00 is refused**, naming the row and the two totals it breaks.

The checks compare the report with its own printed totals, and those come from PioneerRx, not the rows; so a
misread cannot agree with itself.

### 4–5 · Where it lands; basis

One row per period in `sales_by_payment`. **It books nothing on either basis**: it is a check.
- Rehearsed as it is: before the books, kept, nothing recorded.
- A year on: stored.
- The same period again: *"replaces that one"*.

### 6 · What it matches, and what could not be rehearsed

Its two checks are the till's card figure against the card batches for the same days, and prescription money
against the claims sold those days. **Neither could be exercised on this sample.** No card batch and no claim
for 30–31 August is on the site (the books start 1 September), and the batch closed 31 August is on the
September card statement, which does not exist yet. A year on, the checks correctly say *"no card batch report
is on file … cannot be checked yet"* and *"0 claims … against PioneerRx's $43,919.34"*.

**To rehearse them, one more sample is needed and PioneerRx can produce it today:** the same report run for
**3–14 September**. The site holds all 8 card batches for those days ($34,112.41) and the claims sold on them.
That single run would test both checks, including the two joins section 1 left unverified: batch close day
against sale day, and how reversals net.

### Gaps for this feed

None that the sample can show. One observation for the owner's run: the sample's file name begins
"Accrual_", which suggests PioneerRx offers this report on more than one basis. Which basis the daily reports
should use belongs with Q-CARD-2 (whether account payments appear).

### Not checked, said out loud

- The card and prescription checks (above).
- A report covering a single day, which is how the owner sends them: the sample covers two.

---

## 8. The other suppliers, and wholesaler rebates — rehearsed

**Checkpoint 8. Code at 7b71c14.** Samples:
- the invoices and PioneerRx receiving rows on file for IPC, IPD, ParMed, Anda, JamsRX and Xymogen;
- the real McKesson rebate statement on file (July, $9,706.52) and the three real bank credits that paid it
  (August bank statement, read by eye).

Fresh snapshot, 17:54 UTC.

### Suppliers without a ledger feed

**Cash cost of goods for September, from the real `cashCostOfGoods`: $136,551.40.** That is McKesson's ledger
$106,322.62, plus invoice dates $15,000.21 (IPC, IPD, ParMed), plus PioneerRx receiving where no invoice
arrived $15,228.57. `countedTwiceInCash`: 0.

That check matches exact invoice numbers only, so each supplier was also searched for the same delivery held
under two spellings or matching by amount:

| supplier | invoices | receiving | numbers equal | equal once letters/zeros removed | same cents, different number | receiving with no invoice |
|---|---:|---:|---:|---:|---:|---|
| IPC | 11, $10,283.05 | 14, $12,195.81 | 8 | 0 | 0 | 6, $4,197.26, all dated 1–3 Sep, before invoices began arriving on the 4th |
| IPD | 1, $3,255.70 | 2, $3,483.64 | 1 | 0 | 0 | 1, $227.94 |
| ParMed | 6, $1,461.46 | 14, $3,417.21 | 5 | 0 | 0 | 9, $2,049.02 |
| Anda / JamsRX / Xymogen | 0 | 1 / 2 / 1 | — | — | — | all, $8,754.35 |

- **No delivery is counted twice.**
- Of the invoices whose numbers match receiving, every IPC and IPD one agrees to the cent. Two ParMed
  invoices are **$4.83 and $1.57 above** their receiving rows; cash takes the invoice, which is what is paid.
- IPC's one letter-numbered invoice is a **−$199.00 credit memo**, with no receiving row, and reduces cash cost.
- Invoices on 14 September with no receiving row yet (IPC $2,279.83 and $203.67, ParMed $86.87) are
  counted from their invoices.

These suppliers stay on invoice dates, which the account says in words. Whether IPC's daily "Independent
Phar/WAREHOUSE" debits match those dates is for the bank rehearsal.

### Wholesaler rebates

**Where it lands, and which basis reads it** (`rebate-report-store.ts` 380–430, `profit-and-loss.ts` 487–503):
- the statement books a bill in "Wholesaler rebates", negative, dated the **period earned**;
- where the statement prints a paid date, it also books a cash receipt of kind `rebate`, keyed on the statement;
- **accrual:** the stated bill replaces the ladder's estimate in the month earned;
- **cash:** the receipt counts in the month it arrived, and the bill is dropped so it is not counted twice.

Rebate receipts are excluded from cash revenue and reduce cost of goods instead.

**Live:** July's statement gives a bill of −$9,706.52 dated 31 July, paid 19 August, and one receipt of
$9,706.52 received 19 August. Both are out of books.

**Against the bank:** the August statement shows the rebate as **three credits on 19 August: "HEW LLC/BRAND"
$1,109.76, "HEW LLC/GENERIC" $8,246.76 and "HEW LLC/FEES MISC" $350.00**. That is exactly the statement's own
brand, generic and fees split.

**Rehearsed:** the three real lines read against that receipt, with the real `placeLine` and
`matchHeldDeposit`, and the `/money` form's check for each:

| bank line | placed | matched | typed on /money |
|---|---|---|---|
| HEW LLC/FEES MISC $350.00 | unplaced: *"a deposit from nobody the site knows; bank it by hand with the payer"* | nothing | **form banks it** |
| HEW LLC/BRAND $1,109.76 | unplaced, same | nothing | **form banks it** |
| HEW LLC/GENERIC $8,246.76 | unplaced, same | nothing | **form banks it** |

### Gaps

**G-REB-1. A rebate paid as several bank credits is not recognised, and the screen's advice for it counts the rebate twice.**
OBSERVATION: rehearsed with July's real rebate.
- The bank pays it as three "HEW LLC" credits that sum to the one receipt already banked.
- No descriptor knows "HEW LLC", so each is unplaced with *"bank it by hand with the payer"*.
- `matchHeldDeposit` looks for receipts summing to a line, never lines summing to a receipt, so the
  receipt is not confirmed.
- The `/money` form does not refuse any of the three amounts.

Typing them in would bank $9,706.52 a second time. If typed under any kind other than `rebate`, it would
count as revenue.
SHOULD BE: one rebate is one receipt, whether it arrives as one credit or three. The site's instruction for
a line must not be the step that doubles it (the principle of G-CARD-8).
DIFFERENCE: yes, rehearsed. July's rebate ($9,706.52) arrived this way. Whether every month's does is
never-measured: one bank statement is on file. Live exposure: measured-and-none (no bank statement read).
Owner:
- `bank-descriptors.ts` / `bank-statement.ts` — not in the table;
- `money/page.tsx` — **A**;
- the matching engine (many lines ↔ one receipt) — session 1's queue.

Proposed fix: (a) a descriptor for HEW LLC as McKesson's rebate, whose unplaced message says the rebate
statement banks it; (b) the matcher also tries 2–3 same-day lines from one counterparty summing to one
unconfirmed receipt, and links them.

### Not checked, said out loud

- Whether "HEW LLC" is McKesson's rebate entity in name: the identification rests on the three amounts
  equalling the statement's own split, to the cent.
- IPC's, ParMed's and Anda's bank debits against their invoices: waits for the bank reader.
- The ladder estimate itself (`earningSoFar`): not re-derived.

---

## 9. Postage (Endicia / Stamps.com) — rehearsed

**Checkpoint 9. Code at 7b71c14.** Samples:
- the three real Endicia purchase confirmations on file;
- the August bank statement's ten real Stamps.com card charges (read by eye).

### 1–4 · What it is, door, where it lands

Endicia emails a "Purchase Confirmation" with no attachment each time postage is bought by card. The mail sweep
reads the body (`postage-email.ts`), only from @endicia.com or @stamps.com and only with that subject, and
books one bill in "Postage and shipping": dated and paid on the purchase day, confirmed, keyed
`POSTAGE|<vendor>|<order number>`.

**Live:**

| received | from | on arrival | bill |
|---|---|---|---|
| 8 Sep | @endicia.com | "not for filing — nothing on it to file" | $100.00, 8 Sep (booked afterwards) |
| 10 Sep | @endicia.com | "not for filing — nothing on it to file" | $100.00, 10 Sep (booked afterwards) |
| 15 Sep | @endicia.com | **read and booked by the sweep**, order …5518 | $100.00, 15 Sep |

**Automatic since 15 September.** None before 8 September. A forwarded copy (from a staff address) would
not be read: the sender must be Endicia's.

### 5 · Basis

An operating expense. Accrual by purchase date, cash by the same date, since the card is charged that day.
The bank line is treated as the same money (`bank-descriptors.ts` postage rule, `alreadyCounted`).

### 7 · Duplication and completeness — rehearsed

The ten real August Stamps.com charges ($940.99), through the real `placeLine`:
- **all ten are `already_counted`**, and **no postage bill exists for any of them** (August has none on file);
- one is a **$40.99** charge from "Stamps.com El Segundo CA", a different merchant line from the $100.00
  top-ups;
- a September line for the 9/15 purchase (bill on file) → `already_counted`, which is right;
- a September line with **no confirmation behind it** → `already_counted`, which is wrong.

### Gaps

**G-POST-1. Every Stamps.com bank charge is called "already counted", whether or not anything counted it.**
OBSERVATION: the postage rule marks the bank line already counted unconditionally. Rehearsed with the ten
real August charges: all $940.99 placed `already_counted` with no bill for any, and the same for a September
charge with no confirmation email. A missed or unsent confirmation (the 8 and 10 September emails were at
first filed as nothing to file), or a charge that is not a top-up (the $40.99 El Segundo line), is dropped
from the books with a sentence saying it is on them.
SHOULD BE: "already counted" is a claim about a record, and it holds only where that record exists. A card
charge with no bill behind it is postage nobody has booked, and the line should say so.
DIFFERENCE: yes, rehearsed. Dollars: every Stamps.com charge without its email, of which August shows the
shape (10 charges, $940.99, a month). How many of September's charges have an email: measured-and-none so
far, because the September bank statement is not in yet.
Owner: `bank-descriptors.ts` / `bank-statement.ts` — not in the ownership table.
Proposed fix: already counted only when a postage bill of the same amount exists within 3 days of the bank
date and no bank line has claimed it (the card-fee rule's shape). Otherwise, unplaced: *"a postage charge
with no Endicia confirmation on file"*.

**Q-POST-1 (question for the owner).** What is the monthly **$40.99 "Stamps.com El Segundo CA"** charge (18
August): the Stamps.com subscription, or postage? If it is the subscription, no confirmation email will ever
book it, and it needs a standing cost or a vendor bill.

### Not checked, said out loud

- Whether Endicia sends a confirmation for every purchase: the September bank statement will show it.
- An Endicia confirmation carrying a surcharge: none of the three does.

---

## 10. RedSail copay-voucher remittance (the scanned sample) — measured, not rehearsable

**Checkpoint 10.** Sample: the owner's upload `Image_001.pdf`, a RedSail copay-voucher remittance. It was measured
by shape only: every word reduced to its length and every digit masked, because a voucher can carry
patient-linked rows. The page images were not looked at.

**What the file is:**
- 2 pages, each one scanned image of about 3,400 × 4,400 pixels (about 400 dpi on letter paper);
- a text layer is present;
- no OCR producer is named in the file.

**Is the text layer readable?** Mostly.

| measure | value |
|---|---|
| characters / lines / tokens | 2,014 / 130 / 227 |
| clean words | 74 |
| money-shaped figures | 15 clean tokens; 64 figures found in the text |
| garbled tokens (letters and digits mixed, or non-printing) | 28 (12%) |
| labels present | Payment, Total, Amount, Date, Voucher, Copay, RedSail, Remit, Pharmacy, Rx, Paid |
| the payment figure | $177.25, printed at the top and again at the foot |

The figures follow a remittance's pattern: charges with their reversals (+$1,177.90 / −$1,177.90,
+$1,350.00 / −$1,350.00, and so on), handling amounts ($2.00, $0.25, $28.00), and a net of $177.25.

**What the site does with it:** `classify` → **unrecognised**; `looksLikeCopayRemit` → false. The text comes
out one field per line, so the reader's row pattern never forms.

**Answer for session 1's OCR decision:** for this document **the text layer already carries the figures,
largely clean**. OCR is not the missing piece. A reader that rebuilds rows from this layer's field order
is. Whether every row's fields are present and in order could not be proven by shape alone, since the row
text is patient-linked, and was not read.

**Against the bank:** August's RedSail credits (8/04 $225.22 and $67.50; 8/11 $501.97; 8/18 $2,324.01; 8/25
$1,375.98) include no $177.25. The voucher's own date was not printed, so which month it pays is not
established.

No gap is written: nothing was read, so nothing was stored wrongly. The state is **not-captured**, because
there is no reader for this layout.

