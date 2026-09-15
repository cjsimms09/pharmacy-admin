# What is open, and who has it

The owner, 12 September 2026: *"you need to be keeping track of all these things and they need to be
corrected.. use other sessions"* — and then: *"but youre still in charge of making sure they all get
done, do not miss any"*.

So this file is the register. Every finding that is not yet fixed goes here the moment it is found,
with the money against it and who it is waiting on. A finding that lives only in a chat message is a
finding that gets lost, and today three of them nearly were.

**Rules.** Nothing leaves this list because it got old — only because it is done, or he decided not
to do it (and then it moves to the decided section of `DAILY-CHECK.md`). Money figures carry the date
they were measured, because they move. Anything delegated to another session names what was asked,
so the answer can be checked rather than taken on trust.

---

## Waiting on him — cannot be finished without an answer

| What | Money | The question |
|---|---|---|
| **Login almost never works** | — | When it fails, is it the pharmacy computer or a different one? The server records success every time (77 successes, 4 failures, 78 sessions, ten successes in 73 seconds on 9 September), so his browser is not landing. A separate cause was found and fixed on 12 September — every action's result was being served from a stale cache — but that does not explain a login that never lands, so this stays open. |
| **The brand book loses money** | **−$2,019.24 of September gross profit** | Generics return 43.0% on 1,765 scripts. Brands return **−1.6%** on 182 scripts carrying 73% of the revenue. Two items did most of it: Rexulti 1.0mg, 3 scripts, −$1,328.39 (−44.4%); Zepbound 12.5mg, 3 scripts, −$1,053.81 (−50.5%). GLP-1s are not losses but not a business either — Wegovy 1.9%, Ozempic 0.6%, Mounjaro 3.5%. **No MAC appeal reaches a brand**, so this is a contract question or a do-not-dispense question, and both are his. It is also the answer to "i just feel like our accural is too low for the month": it is low, and this is why. |
| **rx 336826, cephalexin, $23.36** | $23.36 | The fifth stale claim. The settler deliberately left it: it is the only live row on its fill, so nothing confirms the fill happened at all, and reversing it would take a whole fill off the books on no evidence. Needs him to say whether that prescription was dispensed. |
| **8 claims where PioneerRx's cost disagrees with an invoice dated the same day** | **$419.53 overstated, all of it inside accrual COGS** | Where the pharmacy holds an invoice for the same NDC on the same day, should the site prefer the invoice over PioneerRx's `acquisition_cents` and show the difference — or leave PioneerRx's figure alone and only flag it? Nothing has been overwritten either way. **The measurement says PioneerRx is normally right**, which is what makes these eight worth asking about: across 758 solid-dose September claims with a pack size the catalogue corroborates, the median claim-to-invoice ratio is exactly 1.0000 and 487 are within 5% of it. So this is not two different cost bases — it is a few drug records whose cost was never updated when the price changed. Worst three: rx 337350 mirabegron ER 50mg, claim $297.98 against ParMed 7491190346 of the same day at $175.67 (1.70x, $122.31); rx 337512 ivermectin 3mg (1.63x, $186.57); rx 337115 doxepin 3mg (6.48x, $83.57) — and that last one carries two paid rows under two different NDCs, so it may be one of the stale rebills rather than a cost fault. Measured 12 September. |
| **19 plans still unclassified** | the residual after 459 were adopted and 15 he decided himself | Almost all of it is the one question no document on file answers: is this employer insured, or does it fund its own plan. Needs a Form 5500 or the plan document, one plan at a time. Each row now shows what the plan pays for and whether it ever pays alone, which is what settles a card. |

### Before he decides the brand book: six fills carry all of it — 15 September

He asked about it ("2", the second item above). It is not ready to decide yet, and the reason is
arithmetic already on the row.

**OBSERVATION.** The brand book is −$2,019.24 of September gross profit (measured 12 September).
Rexulti 1.0mg, 3 scripts, −$1,328.39, and Zepbound 12.5mg, 3 scripts, −$1,053.81, sum to
**−$2,382.20 — 118% of the whole brand loss.** The other 176 brand scripts made **+$362.96.** And
those six run at a margin of −44.4% and −50.5%: reimbursed at 0.556 and 0.495 of what they cost.

**SHOULD BE.** A routine brand claim is paid close to what the drug costs the pharmacy. Contracts
price brands at WAC or AWP less a modest percentage, so an independent pharmacy's brand losses run to
low single figures — which is exactly what the other 176 show. A drug reimbursed at half its
acquisition cost on an ordinary fill is outside that range by an order of magnitude. That is pharmacy
practice, not an inference from this data.

**DIFFERENCE.** Yes, and the size of it points at the measurement before the price. A loss of that
depth on six fills, when the rest of the book is positive, is what a unit mismatch on the cost side
looks like (Zepbound is a four-pen carton), or a second payer that was not counted (both drugs carry a
manufacturer savings card), or a fill still in the will-call bin being set against its cost.

**So the question has changed.** It was "stop dispensing these, or take it up with the contract". It
is now "are these six real" — and until that is answered, **the brand book as a whole is not losing
money on the evidence we have**, because remove six unverified fills and it is positive.

**Pre-flight.** 1 Physical act: dispensing, or declining to dispense, Rexulti and Zepbound. 2 Time:
September's six; the decision governs every one after. 3 What a pharmacist knows the tables do not:
brands reimburse near cost; both drugs have savings cards; Zepbound is a four-pen carton. 4 Whose
money / basis / already counted: accrual gross profit; a savings card paid as a second payer could be
a separate row. 5 Units: **not verified — the likeliest fault.** 7 Worst case, ranked: **patient
harm.** Acting on a false loss means declining a patient's Rexulti or Zepbound, which outranks every
dollar on this list. 8 Could the check pass for the wrong reason: yes — the loss reconciles as
arithmetic while resting on a cost in the wrong unit. 9 When he needs to know: before any
do-not-dispense decision, which is now. 11 What else reads this figure: the answer given to "our
accrual is too low for the month", which rested on it. **12 Not checked, and cannot be from here:**
revenue on those six through `ingredientReceivedCents()` (the single definition since 14 September,
after the claims book was found comparing cost against the plan's share net of copay); acquisition
against the invoice or receipt for the same NDC; quantity dispensed against the carton; and whether any
has a second payer or is still unsold. Asked of session 1, 15 September.

## Being corrected in another session

| What | Money | What was asked |
|---|---|---|
| ~~**One authoritative pack size per NDC**~~ | — | **Done, 12 September** — `src/lib/pack-size.ts`. See the done list below. |

## Decisions he made today, so nobody reopens them

- **A MAC appeal needs a shortfall over $30.** His words: "thats not worth it, rather chase other
  things wrong with site.. lets set a limit for mac claims (have to lose more than $30)". Of 117
  below-NADAC Caremark claims worth $645.74, only 38 could be proved with an invoice and those came
  to $95.85, the largest $6.78 — 38 verification codes typed by hand for two and a half dollars
  each. Money under the floor is still counted and still owed; it just does not reach a worklist.
  `MIN_WORTH_FILING_CENTS` in `mac-appeal-candidates.ts`.
- **A reversal of a dispensing from before 1 September is forgotten.** "we are starting evrything
  clean as of 09/01, so if it is a reversal of a claim from before 09/01 we can forget about". 23 of
  the 28 on file. Still stored, counted apart: nothing was ever counted for them to cancel.
- **Cardinal Health, RrcPharmaSolution and TopRx use the PioneerRx receipt as the invoice.** No
  document is coming, so the site no longer asks for a sending address.
- **Revenue stays recognised at pickup, not at fill.** Asked and answered on 12 September: the stock
  is still his until the patient takes it, the cost is held out with the revenue, and an unclaimed
  script gets reversed. $92,154.24 sits in the bin and the account says so.

## Found 14 September, written to the three-line gate

### The PioneerRx receipt does half the job the owner asked of it

**OBSERVATION.** `pioneer_purchases.itemsJson` carries the per-drug figures of every delivery
PioneerRx booked in — ndc11, quantity, unitCostCents, extendedCents, packSize. Exactly one module
reads it: `invoice-price-check.ts`, which uses it to check invoices that *did* arrive. Nothing reads
it as a cost. `product-ledger.ts`, `minimum-store.ts`, `over-nadac-store.ts`, `appeals.ts` and
`returns-due.ts` all read `invoice_lines` and only `invoice_lines`, and `invoice_lines` is written
only by `storeInvoiceLines` from an invoice document's own text. Invoice coverage is 51%
($118,449.24 of $230,143.13, measured 12 September).

**SHOULD BE.** The owner named two jobs for this data and the schema records both in his words:
*"standing in for a purchase whose invoice never reached the pharmacy"*, and checking the invoices
that did. He was explicit about the first — *"I more just wanted to use it to catch the money from
invoices we didn't get before this was setup in September."* A delivery the pharmacy booked in, with
the wholesaler's own per-drug figures on it, is evidence of what a drug cost whether or not the
invoice was ever posted. That is pharmacy practice rather than an inference from this data: the
receiving record is what a pharmacist reconciles against, and it exists precisely because the paper
is slow.

**DIFFERENCE.** The second job is built and the first is not. Roughly half the pharmacy's purchases
by value have no per-drug cost reaching any screen that prices an order, times a return or backs an
appeal — while the figures sit in the database, already parsed, one table away.

**What this must not become.** The owner also said *"we shouldn't be taking pioneer order receipts
as invoices, invoices are mailed to us from suppliers and that's what we have to keep"*, and the
schema keeps them in a separate table on purpose so no query can count a delivery twice by
forgetting a flag. So the answer is **not** to write `invoice_lines` from a receipt. It is a cost
source that names its own authority, is visibly weaker than an invoice, and never reaches the money
accounts unless he says so.

**Money: $146,612.51, and it is not a chase.** Corrected 14 September. The first figure —
$157,264.78 across 62 deliveries — was a raw SQL join that ignored the site's own rules, and the
site's own answer is different in both directions. `invoicesStillOwed()` reports **0 invoices still
to chase, $0.00**, and 50 invoices worth $146,612.51 from before the mailbox was watching, across
four suppliers. JamsRX and Xymogen carry `invoice_from_pioneer`, so their receipts already are their
invoices; ParMed's nine are settled; McKesson, IPC, IPD and ANDA all pre-date `filingSince`. Nothing
is waiting on anybody, the owner has said he does not want the 1–8 September backlog chased, and
McKesson is now sending everything — every McKesson gap is before 9 September, zero after it, 29 of
31 deliveries invoiced since.

**So the gap is real and it is not the gap it looked like.** Those 50 deliveries have no
`invoice_lines`, therefore no per-drug cost on any screen that prices a buy or times a return. That
is what `drug-cost-source.ts` answers and nothing reads it yet. Wiring it into the buying-side
consumers is session 1's, by agreement on 14 September, because the consumers are its files — with
two constraints carried from the module's docstring: `provable()` gates anything that reaches a
payer, since a receipt is not a document the pharmacy can produce; and nothing receipt-derived may
reach `profit-and-loss.ts`, which sources purchases from the wholesaler invoices dated in the month
and would double-count the stock check.

**The six lines with no drug code: answered, and there is nothing to build.** All six are correctly
codeless — the field is empty rather than malformed, so `ndc11()`, `ndcFromUpc()` and the
twelve-to-eleven reading are all inapplicable. Two McKesson front-end items, a dressing and an elbow
support, and four Xymogen nutraceuticals; Xymogen is a supplements house and none of its catalogue is
an NDC drug. $429.45, correctly outside every per-drug figure, and `coverage` says so in a sentence
rather than dropping them silently as it used to.

### The site had no answer to "are these two names the same wholesaler"

**OBSERVATION.** The invoice proof's first real run, 14 September: 35 invoices, 35 reconcile, 0
disagree, 0 hold no lines, 0 undated, 0 readable better now, **10 under the wrong wholesaler**, 0
unreadable. All ten were one wholesaler written two ways — nine filed `IPC` against pages reading
"Independent Pharmacy Cooperative", one filed `IPD` against "Independent Pharmacy Distributor".

**SHOULD BE.** A check's own sentence has to be true of what it reports. "Filed under a different
wholesaler than the page now names" was false on ten of ten.

**DIFFERENCE.** Yes, and the cost is not the noise — it is that a genuine ParMed-under-Cardinal would
have been indistinguishable from it on the screen. A row that cries wolf ten times is a row nobody
reads on the eleventh.

**Fixed 14 September.** The comparison had been written twice, in `scripts/prove-invoices.ts` and in
`drug-cost-source.ts`, and both copies missed the same case: an acronym against its own expansion.
`sameWholesaler` in `supplier-match.ts` is now the one answer and both call it. It works from the
two strings rather than an alias list, because an alias list goes stale the first time a wholesaler
is added by somebody who does not know it exists. Same shape as `sameDrugCode`: two writings of one
thing read as two things.

**Not a similarity score, deliberately.** Either these are the same company or they are not, and a
threshold would make the answer depend on a number nobody can defend.

**Pre-flight.** Physical act: boxes arriving and being booked in at the counter. Time: affects every
period already loaded. What a pharmacist knows that the tables do not: that the receiving record is
reconciled against, not the invoice. Whose money / already counted elsewhere: **the risk that
matters** — `profit-and-loss.ts` sources purchases from "the wholesaler invoices dated in the
month", so a receipt-derived cost must stay out of it or the stock-movement check double-counts.
Worst case ranked: money, not patient harm. Could it pass for the wrong reason: yes — a receipt and
an invoice for the same delivery must be one cost, matched on the wholesaler's own invoice number,
which is the join `invoices-owed.ts` already uses. **Resolved since.** Both unknowns answered on 14 September. There are no older rows — every
`pioneer_purchases` row is September 2026 and all 96 carry both columns — so no text fallback is
carried, and a backfill of pre-September deliveries must be refused here rather than read from prose.
548 of 554 lines have a usable NDC. **The 6 that do not were looked at on 14 September and all six
are correctly codeless** — the field is empty rather than malformed, so `ndc11()`, `ndcFromUpc()` and
the twelve-to-eleven reading are all inapplicable. Two McKesson front-end items, a dressing and an
elbow support, and four Xymogen nutraceuticals; Xymogen is a supplements house and none of its
catalogue is an NDC drug. $429.45, correctly outside every per-drug figure, and `costCoverage` says
so in a sentence rather than dropping them silently.

## Readings recorded — 14 September

Rule 6 says a review that happens after the push and changes nothing leaves no commit to carry a
`Read-By:`, and that it goes here as a line or is not recorded at all. These are those lines.

**63bf908, the `Read-By:` clause itself — read by session 2, 14 September.** Session 1 asked for it
to be read before it stood and pushed it carrying no trailer, because nobody had. Two things came
back; the first is in the half the rule says can be believed.

*"A commit without one is reliable evidence nobody else read it."* It is not, yet. It is reliable
evidence nobody **recorded** a reading, and for the first weeks those are different: the convention
is a day old, so an absent trailer mostly means the habit has not formed rather than that the words
went unread. The negative is the half the rule rests on, so it is the half that has to be stated
exactly — and a noisy negative early on invites the conclusion that the control is failing when it is
only new. Proposed wording: absence is reliable evidence that nobody recorded a reading, and becomes
evidence that nobody read only once the trailer is habitual.

*"That gap produced three faults in one day on 14 September."* True of the three that earned the
clause and no longer true of the day: the nine forward-dated references, the invented duration, the
attribution of my drift to session 1, and session 1's own "began" against "became dependable" are
four more of the same class, all found after it was written. The sentence does not say which it
means. Not worth a count that will go stale again — worth "the three that earned this clause", which
cannot.

Neither changes what the rule does or how it is followed. Session 1 owns the wording.

## Open against rule 6 itself — 14 September

### It is the only control here that cannot show it ran

**OBSERVATION.** Six nightly proofs each re-read a source file and print what they compared: the
catalogue against the wholesaler's file, NADAC against the CMS files, the claims against the stored
reports, the shelf against its own record count, the invoices against their documents. Every one can
be asked "did you run, and on what" and answer. Rule 6 has no source to compare against — the
instrument is a person reading — so it cannot answer either question. There is no record anywhere of
a sentence having been read by somebody who did not write it.

**SHOULD BE.** A control that cannot be shown to have run is indistinguishable from one that has
stopped, which is the whole reason the six proofs carry their own date: a job that dies leaves a row
that ages visibly rather than a row that looks fine. Rule 6 has the failure mode those were built to
prevent, and it is the newest and least practised rule in the set.

**DIFFERENCE.** Yes, and session 1 named it rather than papering over it — its own words, that it
will say so to the owner rather than let it sit alongside the others as though it were the same kind
of thing. That is right and this entry is not a complaint about it.

**A partial answer, offered rather than adopted.** The rule already records the *absence*: a figure
shipped with no second reader says so in the same breath. What nothing records is the presence. A
`Read-By:` trailer on a commit, in the same shape as `Co-Authored-By:`, would make the question
answerable — `git log --grep` says which work was read and by whom, and more usefully which was not.

Its limits, said plainly because an attestation that oversells itself is worse than none: it records
that the control ran, never that it ran well. It can be typed without reading, exactly as any trailer
can. It proves nothing about a sentence's truth. What it buys is that absence stops being invisible,
which is the same and only thing the proofs' dates buy.

Session 1 owns the wording of rules 1 to 6 and this is a proposal to it, not a change to it.

**Correction to the record while here.** Commit 294c729's message says *"Session 1's messages said
the fifteenth too, and I took the date from the conversation rather than from the clock."* The first
half is false. `git log -S"15 September"` returns five commits and all five are mine; session 1
checked and its text says 14 September for Monday's work and 13 September for the Sunday file, both
correct. I asserted a fault in somebody else's work while owning my own, without checking, and the
effect of it would have been to make a drift that was mine alone look systemic. Worse than the nine
dates, and found only because session 1 disputed it rather than accepting the company.

## Found 15 September, daily check — session 1

| Item | Money | State | Owner |
|---|---|---|---|
| **Brand book "losing $2,019.24" is a measurement fault.** Rexulti makes money on every September fill (1.033–1.040 of cost); Zepbound pens lose ~$30 on two ESI fills paid 97% of acquisition. Cause: primary+secondary pairs (Rexulti 335651, Zepbound 337199) are two claim rows each carrying the full cost, plus a reversed unsold Rexulti (337216). Found by session 2. | −$2,019.24 → ≈ −$37 | **told him not to act on it** | 1 |
| **Below-cost totals were counted per claim row, not per fill.** $11,951.77 of September's $25,522.19 per-row below-cost sits on the 76 fills with two payer rows (2.6% of fills, 47% of the money). Every figure from the claim-remedy probes on 14 September is overstated by up to that. Nothing filed or shown from them. Router to be rebuilt on fills; COB revenue (which copay is final) is not knowable from row order alone and is not to be guessed. | up to $11,951.77 | not started | 1 |
| **13 fills, $2,568.02, in PioneerRx and not in the site**, from 4–10 September (one $1,204.25 on the 4th). Not the day-behind timing gap — the copy and the reports both cover those days. `pioneer_claims_reconcile`. | $2,568.02 | **not diagnosed** | 1 |
| **"$23,076.03 they have not sent"** on the McKesson chase line. All 11 deliveries are dated 14 September and McKesson invoices arrive the next day, so the true state is *expected, not yet arrived*. The sentence says more than one day supports — the eighth shape. Wants a grace day before it says "not sent". | $23,076.03 | not started | 1 |
| Basis of reimbursement 20: no definition on this machine. Contracts (399 docs, 0 hits), PioneerRx (`Prescription.Claim.BasisOfReimbursementDetermination` is a bare column; its code tables cover reject codes only), and the feed all checked. Needs RxLocal/PioneerRx support or the NCPDP external code list. | $19,226.72 on 270 claims | waiting on an ask | him |
| Two ParMed invoices a few dollars above PioneerRx's receiving (7491405516 +$1.57, 7491384103 +$4.83). The invoice is the record; likely a surcharge PioneerRx does not key. | $6.40 | noted, not chased | — |

Fixed and deployed the same morning: the 8am PioneerRx pull had been running at 7pm the evening before
(local hour, UTC date — `5782643`). This morning's pull was then run by hand; the copy is current to
14 September. **The deploy was made while he was connected** (two sessions from 10.133.63.137) — the
check printed "nobody on it" whatever it found, and that line was read instead of the output.

## Mine, not yet started

This heading was deleted by accident on 14 September and restored the same day. I used it as the
anchor for the finding above and the replacement consumed it, so four tracked items sat under
"Found 14 September" with no owner against them — in the register whose first rule is that nothing
leaves the list except by being done or decided. An edit that takes a heading as its landmark should
put the landmark back.

(The first version of this paragraph said they had spent a day that way. They had not: it was the
same session, a few hours. Nobody was harmed by the overstatement and it was still a figure about
the world stated without being checked, in the paragraph about a register describing a world that
had moved.)

| What | Money | Note |
|---|---|---|
| ~~**Invoice coverage is 51%**~~ | — | **Superseded 14 September, see the finding above.** The figure and the framing were both wrong. `invoicesStillOwed()` reports **0 invoices to chase**: the 50 uninvoiced deliveries are from before the mailbox was watching, two of those suppliers send receipts by design, and the owner has said he does not want the 1–8 September backlog chased. It was never a chase. What it is — those deliveries carrying no per-drug purchase price — is answered by `drug-cost-source.ts` and reported on Data health. |
| **5 September reversals cannot be matched to what they cancel** | **$1,277.03** may still be standing as revenue | 336765 on 09-04 at $461.89 and 337203 on 09-09 at $605.94 among them. `claimCancelledBy` is right to refuse: the Wegovy reversal carries an $833.52 copay the live row does not, so it could belong to either run. Each now appears on the recheck with its money. What is missing is a way for him to say which run a reversal cancels. |
| **Payer payment cycles are prose, not days** | — | `payment_routing` holds a cycle for 20 of its 29 payers, every one the sentence the contract printed. Nothing reads a number out of it, so `promise-due.ts` falls back to measurement. One row can carry two cycles for two lines of business, and Caremark's states a sixty-day *reconciliation* cycle that says nothing about when a point-of-sale claim is paid. Parse it wrong and the site invents a deadline. |
| **ANDA has no sending address** | — | Self-resolving: their first invoice is captured from its own page and raised in the Inbox to be named. No action unless it does not arrive. |

## Done today, 12 September

- **One pack size per NDC, and it refuses rather than guess.** `src/lib/pack-size.ts`. "How many
  dispensing units are in this package" was re-derived in four places and three of them used the
  same regex over `package_description` — `/^\s*([\d.]+)\s+[A-Z]/`, which takes the **outermost**
  count. On this pharmacy's own claims that number differs from the truth on **404 of 3,212 fills**,
  by factors from 0.01x to 1000x. Wegovy read 4 syringes against a true 2 mL; the estradiol cream
  read 1 tube against 42.5 g. The fix is that the **dosage form** decides the unit, not the
  innermost level of the text: a lidocaine patch's `30 POUCH / .7 g in 1 POUCH` is 30 patches, and a
  cream's `1 TUBE / 42.5 g in 1 TUBE` is 42.5 grams, and those are the same shape of sentence.
  82 claims that used to get a number now get a refusal with its reason — metered inhalers, whose
  claim quantity is a net fill weight the FDA states nowhere (albuterol bills 8.5 g against a
  described 200 actuations, a factor of 23.5), and oral-contraceptive kits (the claim says 84 and
  the only number in the text is 3, a factor of 28). `claims.quantity_unit` is null on all 3,370
  rows, so the claim's own unit can never be read and the check is arithmetic instead: 3,040 of
  3,212 confirm, 7 are caught counting containers rather than millilitres, 83 are unproven partials
  that are refused to any figure going to a payer. The appeal evidence page can no longer divide by
  one unit and label the answer another — the pack and its unit are one input now.
- **459 plans classified in 61 presses: 1,588 claims, $206,059.80.** The register went from 481
  unclassified to 19, counting the 15 he decided himself.
- A press showed him the page from *before* the press. `held()` keys its cached readings on a
  fingerprint of the tables, but `fingerprint()` cached itself for two seconds — and an action
  writes, redirects and re-renders inside two seconds. Every action on the site had it; `audit()`
  now forgets the fingerprint.
- 4 claims for drugs PioneerRx says were never dispensed, taken off the books: accrual net
  −$520.55 → −$713.03, both bases still balancing to $0.00.
- MAC appeals: a claim no MAC priced is no longer appealed (basis 06/07 only, 1,038 set aside), one
  paid *at* NADAC is refused, one paid *above* it is flagged as the weaker argument, and a
  shortfall of $30 or less does not reach the worklist.
- The plan classification error named the principle and never the control. It now says the action
  first.
- Each plan row shows what it pays for and whether it ever pays alone — the two facts that separate
  a manufacturer card from a benefit plan.
- 10 invoice-vs-delivery disagreements → 0; invoices agreeing 19 of 22 → 22 of 22; lines compared
  215 → 225. A real reader bug behind one: IPD printed a 9-digit NDC column and the reader invented
  the missing two digits.
- "Promised by a plan and not yet paid" no longer alerts inside a 25-day grace period measured from
  the pharmacy's own facilitator payments. $96.89 → $0.00 alerted; nothing stopped being owed.

- ParMed's reader could not cross the DESCRIPTION or NOTE columns — two invoices read as having no
  lines, $945.87 reaching no drug. Fixed; 35 of 35 invoices now reconcile, 0 hold no lines.
- A NovoLog invoice was filed as a Schedule II record because its schedule was unknown. The
  invoice's own NDCs now settle the drawer where PioneerRx has nothing.
- The Inbox re-sort could not re-decide reports, only invoices, so four McKesson reports were stuck
  for ever — one carrying $8,526.77 of credits in a format the sweep already knew.
- `prove-invoices.ts` checked against the invoice total while the importer uses the goods subtotal,
  so it reported three correctly-read invoices as broken, off by exactly the freight.
- Cardinal Health, RrcPharmaSolution and TopRx set as settled; the check that asked them for a
  sending address now excludes settled suppliers and no longer claims an unregistered sender's
  invoices "will not be recognised", which was not true.
- MAC appeals: a claim no MAC priced is no longer appealed (basis of reimbursement 06/07 only —
  1,038 claims set aside), and a claim paid *at* NADAC is refused while one paid *above* it is
  flagged as the weaker argument. This is what Caremark's "non MAC claim" rejection was about.
- **459 plans classified in 61 presses: 1,588 claims, $206,059.80.** The register went from 481
  unclassified to 41.
- A deploy takes the site down and he is usually in it. Rule written into `DAILY-CHECK.md`.
- **"Promised by a plan and not yet paid" no longer alerts on a fill dispensed yesterday.** *"can we
  give these time before alerting.."* The grace period is 25 days, which is the 90th percentile of
  the 31 facilitator payments this pharmacy has actually received — its own measurement, not a
  number anybody picked. The alert went from $96.89 on 1 fill to nothing; the $96.89 is still on the
  tile as money owed, marked "not due yet", and chased from 6 October. Across all of September it is
  $4,056.21 on 14 fills outstanding and none of it late. `promise-due.ts`, shared by the claims page
  and the home page so the two cannot disagree about which dollar is a job.
