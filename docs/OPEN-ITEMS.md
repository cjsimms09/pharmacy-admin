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
| **19 plans still unclassified** | the residual after 459 were adopted and 15 he decided himself | Almost all of it is the one question no document on file answers: is this employer insured, or does it fund its own plan. Needs a Form 5500 or the plan document, one plan at a time. Each row now shows what the plan pays for and whether it ever pays alone, which is what settles a card. |

## Being corrected in another session

| What | Money | What was asked |
|---|---|---|
| **One authoritative pack size per NDC** | has produced two phantom findings near $34,000 and disqualified real appeals | "How many dispensing units are in this package" is re-derived in at least four places, each with its own regex, and none of them checks that the claim's quantity and the pack's count measure the same thing. Wegovy: the claim counts 2 **mL**, the pack counts 4 **syringes**. Estradiol cream: 42.5 **g** against 1 **tube** — a 28x artefact that disqualified an appealable claim. Asked for: one pure function giving the pack size *and its unit*, which **refuses** where it cannot tell. Then reconcile the 43 solid-dose claims whose acquisition cost disagrees with the invoice ($339.59, $313.16 of it inside accrual COGS; mirabegron rx 337350 overstated by $122.31 against a same-day ParMed invoice). |

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

## Mine, not yet started

| What | Money | Note |
|---|---|---|
| **Invoice coverage is 51%** | blocks **$317.69** of provable appeals, and every per-drug cost | Invoices on file come to $118,449.24 against $230,143.13 of PioneerRx purchases. 66 of the 117 below-NADAC Caremark claims cannot be proved because no invoice covers the NDC. Not a reader problem — the documents are not arriving. Worth more than any appeal on that list. |
| **5 September reversals cannot be matched to what they cancel** | **$1,277.03** may still be standing as revenue | 336765 on 09-04 at $461.89 and 337203 on 09-09 at $605.94 among them. `claimCancelledBy` is right to refuse: the Wegovy reversal carries an $833.52 copay the live row does not, so it could belong to either run. Each now appears on the recheck with its money. What is missing is a way for him to say which run a reversal cancels. |
| **Payer payment cycles are prose, not days** | — | `payment_routing` holds a cycle for 20 of its 29 payers, every one the sentence the contract printed. Nothing reads a number out of it, so `promise-due.ts` falls back to measurement. One row can carry two cycles for two lines of business, and Caremark's states a sixty-day *reconciliation* cycle that says nothing about when a point-of-sale claim is paid. Parse it wrong and the site invents a deadline. |
| **ANDA has no sending address** | — | Self-resolving: their first invoice is captured from its own page and raised in the Inbox to be named. No action unless it does not arrive. |

## Done today, 12 September

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
