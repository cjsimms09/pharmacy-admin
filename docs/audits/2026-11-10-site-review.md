# Site review, 10 November 2026 — cloud session (Helper A)

The owner, 10 November: *"Review site for ways to improve, make better, more user friendly, easier to
use, more accurate. This site needs to be an automated, strong, sustainable tool to manage pharmacy
finances, compliance, and other things."*

Read at `feature/compliance` `99846d7` (6 November). **Code and documents only: no live row was read,
no screen was seen in a browser, the test suite was not run.** No money figure and no identifier is
written here, because the repository is public (finding 1).

**Second reader:** a fresh subagent, given this file and the checkout and not my reasoning, told to
find what is false or would make him act wrongly. It returned 36 leads. I read the ones that change
a finding against the code and they held; this file is the version after them. Eight of my first
fifteen findings were wrong in part, and four were already in the register. Findings marked
**known** are in `OPEN-ITEMS.md` or `BACKLOG.md` already; they are here because they are still open.

Order: privacy, then the Board, then whether the site can be rebuilt, then money, then convenience.

---

## 1. The repository is still public
```
OBSERVATION: GitHub's public interface, 10 November, no sign-in: "private": false. Its public event
             list shows pushes to feature/compliance on eight days from 9 October to 6 November.
SHOULD BE:   private. CLAUDE.md: no data, no credentials, no patient information in it. OPEN-ITEMS.md
             line 38 (5 October) asks him and recommends private before anything more is pushed. His
             instruction to this session when the project began: privacy and security come first.
DIFFERENCE:  public, five weeks after he was asked, and pushed to throughout.
```
**Known.** His press: the repository on GitHub, Settings, General, Danger Zone, Change visibility.
Two things go with it. (a) That line holds a second question this does not answer: private does not
recall a copy already taken, and whether the history needs anything more is his to decide. (b) After
the press, open Settings, Updates, Check for updates once on the pharmacy computer. The page says so
if GitHub refuses it (`updates.ts:60`). The evening update does not: `site-control.ps1:106` hides a
failed fetch and then reports "Nothing new is waiting", so fix that line before relying on it.
Not checked: whether private changes the pharmacy computer's or this session's access.

## 2. Board-facing rows are still waiting on him
OPEN-ITEMS.md "Waiting on him", lines 29 to 32, and BACKLOG A6-28, **as last recorded; not re-read
live, and some may be done**: credentials not filed, sensor certificates, one controlled-substance
log entry with no resolution recorded, retention periods, and the manual's open findings. HANDOFF's
top entry also records, as found and not fixed, six September days of one wholesaler's invoices
never captured, some carrying a Schedule II item. They outrank every money item below. Two cautions:
the retention answer has no page to show on and needs a code change (`engine/retention.ts:39`, read
only by `documentsView`, which nothing calls), and the credentials were taken off Today on purpose on
2 October (`alerts.ts:956`), so they show only on Licences and the register.

## 3. Following RUNNING.md on a new computer installs the site of 2 September
```
OBSERVATION: RUNNING.md's setup is `git clone` and a double-click. The clone lands on `main`, whose
             newest commit is 2 September. The launcher updates the branch a copy is on and never
             switches (`launch.mjs:388`). The site runs from `feature/compliance`, about 1,370
             commits ahead; PR #1 between them has been open since 2 September.
SHOULD BE:   the written way to rebuild after a dead computer produces the site he runs, able to
             open the database a backup restores.
DIFFERENCE:  it produces a two-month-old site in front of a newer database.
```
Proposed: make `feature/compliance` the default branch on GitHub (his press, same Settings page),
or merge PR #1; and RUNNING.md names the branch. Not checked: what the old code does on a newer
database.

## 4. Closing a month: two judgements, different tests, and neither reads a proof
```
OBSERVATION: (a) The "Close <month>" button (money/page.tsx:256) shows on `engine/month.ts:126`:
                 month over, bank lines on file, none unplaced, no receipt without a bank line.
             (b) `month-close-store.ts` ("What we're expecting", and its document gates on Today
                 from the 5th through alerts.ts:701): the monthly documents, the rebate statement,
                 the wholesaler's purchases against receiving, and bank lines placed. It has no
                 receipts test and accepts a part-month bank record.
             Neither reads `proof_run`. The comment on close_state (schema.ts:3860) says "every
             proof passed".
SHOULD BE:   his words, 16 September: "it should show month closed only once everything is done,
             money matches and everything lines up". One answer, on the page with the button.
DIFFERENCE:  the button can show while (b) waits on a document; (b) can read closed on half a month
             of bank lines while the button is not offered.
```
**Known** (OPEN-ITEMS.md line 224, BACKLOG A5-1, 7 October; `engine/month.ts` unchanged since). It
holds his open question, whether a failing proof stops the close or is only written beside it, and
a plan that needs no answer: name the failing proofs beside the button and in the audit line. New
here: the 23 October gates went into (b) only. Proposed: the button needs both (a) and (b).

## 5. The nightly proofs and the needs-you list lost their screen
`engine/run.ts` writes seven kinds of proof nightly and rebuilds `needs_you` on every pass. Their
only readers are `engine/read.ts`, called by one support script: the screens were the `/v2` group,
retired on his word on 2 October. **Known** (OPEN-ITEMS.md line 42, BACKLOG A2-5). Today works several
of the same facts out again in `alerts.ts`; I found no equivalent anywhere for bank-to-the-cent or
payments-once. Do **not** put the list on Today as it stands: it would repeat the alerts, and
several proofs fail by construction for a month with no statement (`proofs.ts:29`, `:48`), which is
the "problem versus something to do" fault he named on 6 November. Proposed: the two with no
equivalent become daily-check rules in the "to do" state; the rest stop being written, or the question on
that line is answered.

## 6. October's bank file was on hand and not loaded
```
OBSERVATION: commit 82c286c (6 November): the bank lines on the site were all September's; the
             export he took on 15 October "was never loaded". 9f36bcc: loading it "is the owner's
             to press". The upload is at the foot of the books page.
SHOULD BE:   his rule, 2 October: the cash account is the bank statement. A file he has supplied is
             read, or the site says on Today that it is waiting for his press and where.
DIFFERENCE:  three weeks, and every bank-side check for October said "not yet checked".
```
He set month end for the bank and for the ProviderPay history and said stop asking (17 September),
so this is not a request for more files. It is one press on a file already taken. Not checked:
whether it has been loaded since 6 November.

## 7. The accrual standard is behind his decision of 9 October
`profit-and-loss.ts:1312` takes prescription revenue from the fills whose cost is known, and
`:439` records why, in his words of 9 October. `claim-lifecycle.md` G-LC-2 and dry-run row 4.1
("FAILING in part") were last touched on 5 October and still say otherwise. PR #31 (mine,
17 September) predates the decision, no longer merges, and its first half is superseded by it.
Proposed: correct the two documents to the code; close #31; if unpaid facilitator promises as
revenue is still wanted, raise it alone.

## 8. A fix still waits for a click
He said "do it" to the evening update on 23 October (9a48bb2); what remains is his choice of
option 5 in "Set up this computer". Before he does: it has never been run; the site is down ten to
twenty-five minutes when it installs; it runs only while he is signed in to Windows; and it hides a
failed fetch (finding 1). Today already says how many updates are waiting (`alerts.ts:497`).
"Not deployed" on 67 of the last 80 commit subjects is the state when each was written, not today's;
HANDOFF records an install on 23 October. Not checked: what the site runs now.

## 9. Nothing tells him on his phone that something is to do today
The site answers only inside the pharmacy's network. Its regular mail to him is Monday's note,
which is about compliance (`digest.ts`), and a monthly receivables report. A proposal, his call: a
morning email on a day something is waiting on him and none on a day nothing is, each line a count
and a page name.

## 10. The kept pages still explain themselves in paragraphs
His words, 2 October: "I get a headache looking at this site and trying to read all the paragraphs
and words." Supplier invoices still carries over a thousand words of explanation (a rough count of
the page file). Proposed: on the six kept areas the explanation goes behind a fold and the page
opens on what is waiting and the press that settles it. Not checked: any page in a browser.

## 11. Retired code
7,293 lines of page code sit under the addresses retired on 2 October. The recorded rule for
removing them is a month with no visit, counted in `page_visits` on the pharmacy computer: the
pharmacy session should read that count. OPEN-ITEMS.md lines 39 to 41 are his open questions on what
goes, and the NADAC download has a standing recommendation to keep. One small fault: if the supplies
check throws, Today's could-not-check alert links to a retired page (`alerts.ts:676`; the filter at
`:960` goes by key and misses it).

## 12. The record the sessions share
The six process files are about 156,000 words; one row of OPEN-ITEMS.md is over 21,000 characters; the
median commit subject is about 300. HANDOFF's newest entry is 23 October and the eight commits of 5
and 6 November changed nothing under `docs/`. "Waiting on him" is 21 rows, struck-through ones among
them. Proposed: `scripts/registers.ts` also writes one short page of what is open now, one line
each (what, since when, whose move, the page), generated so it is not a second copy to keep.

## 13. Cash ahead
`engine/cash-ahead.ts` is written every pass and read by nothing; its screen was in `/v2`. He has
not asked for it (REBUILD.md lists it under things he has not asked for), and it projects from the
last proven bank balance, so it is worth nothing until finding 6 is settled. Either stop writing it
or ask him once the bank is current.

## 14. Sign-in and backups: sound from the code
Passwords hashed, five wrong tries in fifteen minutes locks the name, strict http-only cookie, an
alarm while the site is open to the internet; backups daily, each proved by restoring it, pruned in
every place, a monthly rehearsal of the first destination, the key kept out of the archive. For the
pharmacy session to confirm: a second destination is set and is on another disk; the `.env` key is
kept somewhere other than that computer (`backup.ts:190`); the network the other computers use is
not one a visitor can join.

## 15. PR #25
Open since 8 September, 126 commits, no longer merges. The lead's to decide; not to be closed unread.

---

## First, in order
1. He makes the repository private, then presses Check for updates once (1).
2. He answers the Board rows (2).
3. He loads October's bank file (6).
4. The default branch becomes the one the site runs from (3).
5. The close button needs both judgements, and the question at OPEN-ITEMS.md line 224 is answered (4).
6. The evening update reports a failed fetch, then he turns it on (8).
7. The rest, in the order above.

## Not checked
Any live figure or row. Any screen in a browser. The test suite. What the site is running. Whether
the evening update is on. Whether the rows in finding 2 are still open. Whether October's bank file
is loaded. The visit count for retired pages. The compliance pages' content against Kansas rules:
this looked at whether the site closes loops, not at whether each duty is stated correctly.
