# The daily check

The owner asked for this on 10 September 2026, and his words are the brief:

> "create a scheduled task for you everyday to check the site, make sure data coming in correctly,
> invoices coming in correctly, things that come in email being sorted properly to right places,
> money be accounted for properly. If something is wrong or incorrect or not being automated like it
> should you need to diagnose and fix underlying problem... I need you to start operating more as me,
> the human user of this site. I shouldn't have to find everything or fix everything."

Run it every morning after the 8am feeds. It is not a checklist to tick — it is the job of being the
person who notices, so that he does not have to be.

---

## Who this is for and what he uses it for

Cory Simms, pharmacist-in-charge, West Wichita Family Pharmacy, Wichita, Kansas. Not a programmer,
frequently reading on his phone between patients. He uses this site to know whether the pharmacy is
making money, to buy stock at the right price from the right wholesaler, to get paid what his
contracts say, and to stay inspectable.

He does not want a dashboard. He wants to be told the one thing worth doing today, and to be able to
trust every figure behind it without checking it himself.

## Where the data comes from

| Feed | Arrives | Carries |
|---|---|---|
| Daily Rx transaction report | email, ~23:30 | every fill, its payers, copay, acquisition cost, whether it was collected |
| PioneerRx SQL, 8am | `scripts/pioneer-pull.ts` | on-hand, claims, purchases, retail till, suppliers, catalogue (weekly) |
| Balance on Hand | email, nightly | the shelf, same-day — more current than the day-old SQL copy |
| Supplier invoices | email, from the wholesaler | what the pharmacy was billed. **The invoice is the record.** |
| 835 remittances | SFTP mailbox | what payers actually sent. **None has ever arrived — see below.** |
| Payer payment reports | email | deposits, by payment number |
| Copay card / facilitator remittances | email | voucher and MTF money |

PioneerRx is a **day-old copy** — current to about 6pm the previous day. Read-only. Never select
patient name, date of birth, address, phone, SSN, or anything in the `Person.` schema;
`src/lib/pioneer-sql.ts` enforces this and it must not be weakened.

## What to check, every day

Work down this list. Each line names what "wrong" looks like.

1. **Did the feeds run?** `pioneer_pull_*_result`, `sftp_last_result`, `mail_last_sweep` in settings.
   A feed that did not run is silent, and silence is the failure mode this site keeps having.
2. **Did anything arrive and not get sorted?** Anything `stored` with no route, or routed
   `unrecognised`. Press the re-sort first — most of the backlog is arrivals that predate a rule.
   What is left is either a sender the register does not know (one press fixes it for good) or a
   format the reader has never seen (that is a real fix, in `invoice-lines.ts`).
3. **Do the invoices carry their item lines?** An invoice with a total and no lines contributes
   nothing to what any drug cost. If lines are read but refused, they did not reconcile — find the
   difference, it is usually one line the pattern missed, not a scan.
4. **Does the money hold?** Draw the books both ways (`scripts/support/books.ts 2026-09`). Both bases
   must balance to $0.00. Check the double-count register. Check no invoice number is on file twice.
5. **Is what the site says true?** Open the pages he actually opens — the home page, Money, the
   Inbox, Supplier invoices — and read what they claim. Two days of this project were spent on
   screens that reported success as failure and failure as success.
6. **What is the site asking for?** `money-found`'s blocked list, the compliance list, data health.
   These are the things that would put money on the list if they were settled.

## Then fix the underlying problem, not the symptom

Every fault found so far has been one of six shapes. Look for the shape, not the instance:

- **The same money down two roads.** Two feeds carrying one dollar. Ask which pairs can, and whether
  a rule exists for each.
- **A null that means two things.** "Never measured", "measured and it was none", and "nothing to
  measure" are three different facts. Rendering any of them as nought invents news.
- **A comment that outlived its code.** This codebase states its rules in prose. When the prose and
  the code disagree, decide which is right — sometimes it is the comment, and the code is the bug.
- **A rule written twice.** Two copies drift. When you find one, make it one function and have both
  callers use it.
- **A derived unit.** Anything divided by a pack size, converted between EA/ML/GM, or turned from
  per-package into per-unit. A silent factor of 25 lives here.
- **A date deciding a period.** Filled, sold, paid, deposited, invoiced, posted. Mixing two inside
  one figure is invisible and wrong.

## What is knowingly still open

Keep these in view; do not rediscover them.

- **No real payer 835 has ever arrived.** Every payer therefore reads $0.00 received against what it
  owes. That is the third state — nothing to measure — not a fault. It stops being true the day
  RedSail switches the first payer over, and that day the matcher gets its first real test.
- **1,436 claims are on unclassified plans.** This blocks the Kansas floor entirely and $191,569.70
  of reimbursement cannot be followed to a contract. Work is on `work/plan-types`.
- **Revenue is recognised when a script is collected**, not when it is filled. A month in progress
  understates on purpose. A full will-call bin is not a bad month and the account says which it is.
- **Two invoice formats are unread**: the IPC credit memo (bracketed negatives) and ParMed (columns
  run together without spaces). Both real, neither a scan.
- **Nothing calls the model without a person pressing something** — `src/lib/ai-gate.ts`, default
  deny. Do not route around it. If an automatic reader needs the model, that is a design problem to
  raise with him, not a gate to loosen.

## The standard for anything you build or change

He asked for this directly, and it is the part this project has been worst at:

> "you need to do better at design and interface. Is this how you would want each page or tool
> designed as a human for ease of use, ease of digesting and understanding information, ease of
> auditing information"

So, before shipping a screen:

- **Does it lead with the answer?** A ranked list, or one number that means something. Not a row of
  tiles above a table. Only five of roughly 120 screens currently do this.
- **Can he act on it without leaving the page?** The fix belongs on the line with the problem. An
  instruction telling him to go to another screen, do three things and come back is a bug — that
  exact paragraph was printed beside the button that did it in one press.
- **Does it survive a phone?** He reads it between patients. If the important thing is below four
  banners and a scoreboard, it is not on the page.
- **Is what needs him separated from what does not?** Fifty-three arrivals hid the nine that mattered.
- **Does every figure say where it came from,** and does anything uncertain say so in the same
  breath? He audits. Make that cheap.

## How to work

- Deploy: `git push origin feature/compliance`, write `data/.update-requested`, kill the PID on port
  3000, poll `.next/BUILD_ID` until it changes and HTTP is 200/307. `npm run deploy` is blocked.
- Scripts: `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/<f>.ts`,
  starting `import "dotenv/config";`. Throwaway probes go in `scripts/support/` and are deleted after.
- Migrations are additive and numbered, `drizzle/00NN_*.sql` plus a `_journal.json` entry whose
  `when` is the previous +60000. **Drizzle keys applied migrations on that timestamp, not the name —
  a slot that has ever been applied is burned. Always take a fresh one.**
- `npx tsc --noEmit -p tsconfig.json` and `npm test` before every commit. Tests are the thing that
  has caught the most real bugs here, including in work done the same hour.

## What to tell him

Short. Money first. What changed, what it was, what it is now. If a figure moved, say why — he has
watched September's net profit move four times in a day and each time it was a fix, not a fact
changing, and saying so is the difference between trust and doubt.

**Ask when it is genuinely his call** — a business rule, a supplier's terms, what a plan is, whether
a number looks right to him. He has said he will answer. Do not guess at those and do not sit on
them either.

If nothing was wrong, say that in one line. A quiet day is a real result and worth knowing.
