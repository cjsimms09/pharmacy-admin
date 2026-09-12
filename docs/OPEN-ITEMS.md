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
| **Login almost never works** | — | When it fails, is it the pharmacy computer or a different one? The server records success every time (77 successes, 4 failures, 78 sessions, ten successes in 73 seconds on 9 September), so his browser is not landing. That answer decides whether it is the cookie being dropped for that host or the redirect. |
| **5 stale paid claim rows** | **$276.99 revenue, $228.67 of September profit** | PioneerRx's last-valid claim names a different NDC than the site holds, on 5 fills — the site kept the pre-rebill row as paid. Is a single fill here ever dispensed as two different NDCs? If never, these 5 are stale and should be reversed, and September's accrual net moves from −$520.55 to −$749.22. Measured 12 September. |
| **Caremark MAC appeals** | **$645.74** across 117 claims | Needs him to sign in and enter the verification code per submission. 117 below-NADAC claims; 17 lapse the day they are counted. He chose the below-NADAC filter over a top-N cut on 12 September. |

## Being corrected in another session

| What | Money | What was asked |
|---|---|---|
| **10 purchases where the invoice and the delivery disagree** | totals agree; the money is against the wrong drug | Find why the invoice reader and PioneerRx's receiving record name different NDCs for the same line, and fix the cause. Most are front-end items where neither code is a drug in the FDA directory. Every margin below it is computed from which drug the money is against. |
| **"Promised by a plan and not yet paid" alerts too early** | $96.89, 1 fill | The owner: *"can we give these time before alerting.."* — a plan has a remittance cycle and a fill adjudicated yesterday is not late. Give it a grace period before it is called unpaid, keyed on something real rather than a number somebody picked. |

## Mine, not yet started

| What | Money | Note |
|---|---|---|
| **41 plans still unclassified** | the residual after 459 were adopted on 12 September | Almost all of it is the one question no document on file answers: is this employer insured, or does it fund its own plan. Needs a Form 5500 or the plan document, one plan at a time. |
| **ANDA has no sending address** | — | Self-resolving: their first invoice is captured from its own page and raised in the Inbox to be named. No action unless it does not arrive. |

## Done today, 12 September

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
