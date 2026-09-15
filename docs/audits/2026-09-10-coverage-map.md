# What this site already checks about itself, what it does not, and the gap that matters

**10 September, Helper B (cloud).** The owner:

> *"We need to make sure this is a robust and accurate system from start to finish... claims
> tracking, remit tracking, correct ordering, complete pharmacy accounting, understanding pharmacy
> rebates, remits. My family's livelihood depends on it. I don't want to have to babysit
> everything."*

The first thing to say is that the site is further along than that fear suggests, and the second is
that the gap is narrower and more specific than "everything". This is the map, made by reading the
code rather than by asking anyone.

---

## The principle is already written down, and it is the right one

`reconcile.ts` opens with it: *"Every figure has a source, and the ones with two sources are checked
against each other."* Beside it, in `data-health.ts`: *"an absent figure looks exactly like a good
month"* — and the rule that 100% is printed only when the numerator equals the denominator, because
26,245 of 26,246 rounding to 100.0% is the silence the page exists to remove.

Nobody needs to invent a philosophy here. What follows is only whether it is applied everywhere.

## What is checked today

| check | what it catches | where |
|---|---|---|
| **30 link and dataset measurements** with a health per row and gaps in words | a figure that is *absent* rather than wrong: a fill whose NDC found no catalogue row, an insured claim that matched no contract | `data-health.ts`, `data-health-store.ts` |
| **Five nightly proofs** — claims, catalogue, NADAC, FDA directory, on-hand | a stored figure that no longer matches the file it was read from | `data-health-*-proof.ts`, `scripts/prove-*.ts` |
| **Nothing counted twice** — six figures reachable by two routes, which route wins, and what the rule kept out this month | the till and the claims both counting the same prescriptions | `books-check.ts: countedTwice` |
| **Nothing forgotten** — every money-carrying feed, which basis it reaches, what is missing because of it | a feed that reaches neither account | `books-check.ts: feedsInTheBooks` |
| **The statement adds up** — every total is the sum of its lines, every subtotal follows | an account that does not balance | `books-check.ts: booksBalance` |
| **The two bases reconcile** — accrual less cash decomposed into four named parts that add to the gap | a difference between the bases that nothing explains | `books-check.ts: basisDifference` |
| **Cost of goods three ways** — claims, purchases, and opening + purchases − closing | stock bought and not recorded, or dispensed with no cost on it | `reconcile.ts: reconcileCogs` |
| **Revenue against the till and the bank** | billed and not sold, or sold with no claim held | `reconcile.ts: reconcileRevenue` |
| **Adjudicated against paid**, per fill, per payer leg | a plan that short-paid or over-paid | `remit-check.ts` |
| **The 835 must balance** — BPR02 against the claim lines less provider adjustments, and **nothing is stored if it does not** | a segment not read, and the money that went with it | `x12-835.ts` |
| **An invoice that does not add up is refused** | a partial read, which is more dangerous than a failed one | the invoice reader |
| **A fill's payer shares reconcile to its margin** | a coordinated fill split wrongly between two plans | `fills.ts: sharesReconcile` |
| **Pack disagreement** between the catalogue and the drug file | a unit cost n times out on a bracketed pack | `drug-file.ts` |
| **A real report's fields**, in three states — absent, present but empty, populated | a column that exists and is never filled | `report-check.ts` |

That is a serious amount of self-checking, and most of it is well argued in place.

---

## The gap that matters: the site is never checked against itself

Every check above compares the site to **something outside it** — a file, the till, the bank, a
stocktake, the payer's own total. Not one compares **two of the site's own answers to the same
question**. And that is precisely the class of fault that has been found repeatedly this week:

- **The books and the chart disagree about the same month** — a month asked for on its own loads
  fills through a different window than the same month asked for inside a strip, so they return
  different revenue. Nothing external disagreed; the site disagreed with itself.
  (`2026-09-10-sold-month-window.md`.)
- **A month that has been reported changes** when a fill sold in it is returned later.
  (`2026-09-10-reversals-and-835-codes.md`; the owner has since decided the rule.)
- **The undo removes payments the Inbox still says it holds** — two screens, two truths, no check.
  (Reported 10 September.)
- **An 820 payment order was refused by the router and called "a remittance, certain" by the
  inbox** — two readers of one file, disagreeing. (Fixed; `isX12Remittance`.)

None of these could have been caught by any check in the table above, and all four were caught by a
person reading code. **That is the babysitting.** The fix is not more diligence, it is a check of a
kind the site does not currently have:

> **The same question, asked two ways, must give the same answer.** A month's revenue on the books
> and in the chart. A period's total and the sum of its months. A fill's revenue on the claims
> screen and in the account. A document's kind according to the router and according to the
> recogniser. Where two routes exist, the site should ask both and complain when they differ —
> exactly as `reconcileCogs` already does for the three external sources of cost of goods.

## The second gap: nothing counts what the site cannot classify

The rule the owner named — *"identify when we don't [know] or when something is wrong"* — is
implemented in exactly one place, the 835 balance gate, and it is the best thing in the reader.
Everywhere else, money the site cannot place goes quiet:

- provider-level adjustments on an 835, which the receipt sentence says outright are "not yet on
  either account";
- every CAS adjustment code, which is parsed and dropped;
- a payment that matched no claim;
- an invoice with a total and no lines;
- a supplier name that matched no supplier.

Each of these is known and reported somewhere in prose. **None of them is a number.** A single
figure — *money this site has seen and cannot put under a heading* — would have surfaced all five
without anybody auditing anything, and it is the one measurement that gets smaller as the system
gets better. `unclassified.ts` in this branch is that figure, pure and tested; the store half that
counts the real rows is session 1's.

---

## Area by area, ranked by what is missing

**Pharmacy accounting.** The strongest area. Both bases, four-part reconciliation, three sources of
cost of goods, a balance check on every statement. Missing: internal-route agreement (above), the
return rule the owner has just decided, and a stable-month guarantee — once a month is reported it
should not move, and today nothing enforces or even notices that.

**Remit tracking.** Good bones: the balance gate, adjudicated-against-paid, the deposit link. The
hole is the codes — no CARC, RARC, CAS group or PLB code is understood, so an adjustment cannot be
put under a heading and the money at provider level reaches no account at all. This is BACKLOG 2b-v
and the largest single gap in the area.

**Claims tracking.** Reversals, resubmissions, unmatched reversals, two-payer coordination and the
transaction key are all handled carefully. Missing: the sold-and-returned rule (decided, unbuilt),
and nothing checks that a claim's own money adds up on the claim — the patient's share plus every
payer leg against the price of the fill — which is the claim-level twin of what `remitCheck` does
between systems.

**Ordering.** Well covered on inputs — the catalogue proof, pack disagreement, the on-hand proof,
the levelling of bracketed packs. Weakest on outcome: nothing measures whether what the site told
the pharmacy to buy was bought, or what it cost against what was predicted. A recommendation the
site never checks is a recommendation nobody can trust, and `recommendation-log.ts` already holds
the raw material for that measurement.

**Rebates.** The thinnest. The ladder estimates what is being earned; the wholesaler's statement
replaces the estimate when it is entered. Nothing compares the two after the fact, so nobody learns
whether the estimate is any good — and the estimate is what the buy list optimises against. One
measurement (estimated against settled, by supplier, by month) would close it, and it needs only
data the site already holds.

---

## What I am doing about it, and what needs the machine

Mine, from here, pure and tested, in order:

1. **`unclassified.ts`** — money the site has seen and cannot place, as one figure with its parts.
   In this commit.
2. **The agreement checks** — the same question two ways, starting with the month that already
   disagrees. The shape is `reconcileCogs`'s and it slots beside it.
3. **The 835 classification frame** — group and reason code to a bookkeeping heading, with
   *unknown* as a first-class answer rather than a fallback, as set out in
   `2026-09-10-reversals-and-835-codes.md`. The published code lists must come from the machine; a
   dictionary written from memory is the inference this repository forbids.

Not mine and needed: the store halves that count real rows, the code lists, the contract field that
holds a fee's code, and every query under "Open items" in `HANDOFF.md`. **The single most useful
thing anybody at the pharmacy computer can do for all of this is run those queries** — most of them
are counts, none of them moves a file, and each one turns a finding I can only describe into a
finding with a size.
