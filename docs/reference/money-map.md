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

