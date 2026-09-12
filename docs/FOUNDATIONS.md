# What has to be true before any tool is worth building

The owner, 12 September 2026, and this file exists because of it:

> "I want to make sure all of our calculations, remits, claims, ndcs, nadacs, awps, accounting,
> package sizes are all sound then we will start working on actual tools... Package sizes,
> equivalents, NADAC, and everything has to be 100% correct for these tools to be effective."

And the part that is about how I work:

> "return tool was recommending packages that are open, some tools were recommending dispensing a
> 14 day inhaler because it made more money than a 30 day (but that's not plausible)... 1000ct
> bottles are often cheaper per unit than 100ct bottles, but if we don't use very much of that drug
> than it wouldn't be smart to buy 1000ct, it might expire on my shelf... I wish you would help me
> think/find things like this. You're smart enough and know enough to know that but you didn't think
> of it for some reason, I need you to change that thought process."

## Why I did not think of these, and the fix

He asked it directly — *"You're smart enough and know enough to know that but you didn't think of it
for some reason, I need you to change that thought process"* — and the honest answer is specific:

**I was treating the database as the world.** Everything I could verify lived inside it: does this
add up, does it trace to a source, do two tables agree. So that is what I checked, and I stopped at
its edge. But the consequences of a recommendation all live outside it — on the shelf in eleven
months, at the counter in fourteen days, in the tote the wholesaler refuses. "It reconciles" felt
like finishing.

Not missing knowledge. A 14-day inhaler obviously does not fill a 30-day prescription. I never
asked the question that would have made me use what I already knew.

## The ten questions, asked before anything ships

Not a checklist to tick — the point of each is to force a look outside the tables. Any change,
tool or page that produces a figure a person might act on gets all ten, and the answers belong in
the code beside the rule.

**1. What is the physical act?**
Name it: order a 1000-count bottle, put this bottle in a return tote, hand over this inhaler, ring
this PBM. If the act cannot be named, this is a number and not advice, and it must not be presented
as advice.

**2. Then what happens — said in months, not moments?**
The site sees one decision; the pharmacy lives with it. Nearly every error found so far is in the
time dimension: the bottle still there next summer, the patient back in a fortnight, the DIR fee
landing in March, the credit window closing while somebody thinks about it.

**3. What would a pharmacist know that the tables do not?**
Enumerate it rather than gesture at it. Shelf life. Whether the package is open. Whether the patient
will come back. Whether the prescriber allows substitution. Whether that wholesaler actually takes
returns. Each one either gets into the data or gets printed on the recommendation as the caveat that
changes the answer.

**4. Whose money is it, and in which month?**
Cash or accrual, which period, and whether this dollar is already counted somewhere else. See
docs/MONEY-TRACE.md: the same dollar appears in four or five documents on its way in.

**5. What unit is every number in, and do the two being compared share one?**
The recurring one. 404 of 3,212 fills — 12.6% — carried a wrong pack size, by factors from 0.01x to
1000x. A claim counts tablets or millilitres or grams; a package description counts whatever the FDA
chose to count.

**6. Is "the same drug" the same drug for this purpose?**
Four different questions wearing one name: chemically equivalent, substitutable by law,
substitutable for this patient on this therapy, and interchangeable in package size. The
equivalence key answers the first two and nothing else. It is sufficient for tablets and capsules —
1,900 of 2,300 September fills — and insufficient for every whole-package form, which is where
$111,698 of the month's cost sits.

**7. What happens if he does this fifty times?**
Right on average is not good enough. A rule wrong one time in ten destroys the trust that made the
other nine useful, and he will stop reading the list rather than audit it.

**8. What is the worst case, and is it money or worse than money?**
Money lost, a patient harmed, a board or DEA finding, or a PBM that stops reading this pharmacy's
appeals. Rank the risk by its worst case, never by its average — a $4 recommendation that could
produce a dispensing error is not a small risk.

**9. Could this check pass for the wrong reason?**
The one that nearly shipped: dexamethasone described as "100 mg in 1 BOTTLE" produced a pack size of
1, and the claim quantity of 10 divided by it perfectly. A hundred-fold error that confirmed itself.
A check that can confirm a wrong answer is worse than no check.

**10. When does he need to know, and is that when it appears?**
Four o'clock while ordering, the weekly worklist, month end — or never. A true thing at the wrong
moment is noise, and noise is what makes the site busy.

---

## Found so far, by looking rather than by being told

### 0. The money list claims money no act can recover — **$7,492.83 of $10,149.92 a month**

Found by asking question 1 and question 2 of the three biggest items on it, and this is the one that
matters most, because it is the number on the front page.

**payer-spread, $2,736.70 a month, 27% of the total.** The act would be moving a patient from one
plan to another. He cannot do that. The row's own `basis` already says it is "where to look rather
than money already owed" — and then it is summed into a headline that says money found. Nothing is
recoverable here by any act he can take. Over a year the headline overstates by $32,840 on this line
alone.

**dispensed-at-a-loss, $2,800.05 a month, labelled "certain".** Its first named item is Xarelto,
NADAC classification **B**, losing $2,140.80 across two claims. A brand cannot be MAC appealed, the
plan's price cannot be changed, and refusing to dispense a covered drug is a patient decision with a
contract on the other side of it. So the figure is certain as a *measurement of loss* and close to
nothing as *recoverable money*. "Certain" on a list headed money found tells him he can get $2,800 a
month that he mostly cannot.

**cash-pricing, $1,956.08 a month — and its top item is advice that would lose money.** It wants
Contrave raised from $125.00 to $609.02. Contrave cost $89.01, so he is already making $35.99 on
it. Raise a cash price 4.9x and the patient does not buy it: $35.99 becomes $0. Question 2 answers
this in one step and the recommendation never asked it.

There *is* a real lever buried here and it runs the other way. Usual and customary caps plan
reimbursement — if the cash price is below what a plan would otherwise pay, the plan pays the cash
price. So a cash price set too low quietly lowers *plan* revenue on the same drug. That is worth
finding. It is not what this row says.

**What this means for the tools he wants.** Every one of them will produce a number, and the number
has to be honest about which of three things it is: money owed and collectable, money that needs a
decision only he can make, or somewhere to look. The money list currently sums all three. Before any
new tool ships, that separation has to exist — otherwise the first tool inherits a headline nobody
can trust.


### 1. Divisible against whole-package dispensing — **not modelled at all**

This is the inhaler bug and it is foundational. `equivalenceKey` in `drug-directory.ts` is
ingredients + strength + form + route. **Package size is not in it.** So a 14-day inhaler and a
30-day inhaler of the same drug carry the same key, are treated as interchangeable, and the site
recommends whichever has the better per-unit margin.

The distinction the site is missing:

| | What dispensing does | What pack size means |
|---|---|---|
| **Divisible** — tablets, capsules | count out 30 from any bottle | a buying decision only; 1000ct vs 100ct is cost per unit |
| **Whole-package** — inhalers, pens, tubes, drops, patches, kits, unit-of-use bottles | hand over the package | pack size **is** the quantity; a different pack is a different prescription |

Every per-unit comparison in the site is correct for the first row and wrong for the second. Nothing
in the codebase distinguishes them — `grep -rn "divisible"` finds nothing.

**Consequences beyond the inhaler:** a 30g tube against a 45g prescription costs two tubes, not 1.5;
a 5-pen box is not comparable to a single vial per unit; 2.5mL and 5mL eye drops are different
prescriptions. Every one of those is a wrong buy recommendation today.

### 2. "Cheaper per unit" with no idea how fast the drug moves — **not modelled**

His 1000ct example. Nothing in the buy recommendations knows units dispensed per month, so nothing
can say that a 1000-count bottle is eleven months of stock for a drug he dispenses ninety of.

What it needs, and the site has the parts: units dispensed per month (claims), pack size (the
directory, once the pack-size work lands), and a tolerance. Below that the answer is not "cheaper
per unit" but "cheaper per unit and you will still be holding it next summer".

**Related and also missing:** cold-chain and short-dated stock cannot be held long whatever the per
unit price, and a 1000-count bottle of a controlled substance is a different inventory risk from a
1000-count bottle of lisinopril.

### 3. The return tool's "opened" test is a proxy, and it leaks both ways

It is better than he saw — `actNow()` and `return-soon.ts` both exclude `dispensedSince > 0` — but
the main list still offers opened packages with a caveat: *"check what is left before raising it."*
A caveat is not a filter, and he read it as a recommendation. That is the site's fault, not his.

The proxy is also wrong in both directions. `dispensedSince > 0` means units of that NDC left the
shelf since the invoice date, which **over-flags**: buy two bottles, dispense one whole bottle, and
the sealed second bottle is suppressed from the act-now list. Real returnable money is being hidden.

Getting it right needs on-hand quantity and pack size together: if on-hand is at least one full
pack, a sealed pack exists. Which makes it another thing waiting on the pack-size work.

### 4. Five benchmarks, and a claim uses exactly one

AWP, WAC, NADAC, MAC and usual-and-customary are not interchangeable and the site has mixed them.
`basis_of_reimbursement` on the claim says which one the plan actually used — that field is what
made the MAC appeal gate correct on 12 September, and it should be read anywhere the site compares a
payment to a benchmark.

Two specifics worth holding on to:

- **NADAC is a weekly national average of what pharmacies paid.** It is not a floor, not a price
  available to this pharmacy, and being above it is not automatically bad buying. It also has no row
  for a great many NDCs, and an absent NADAC is not a zero.
- **Usual and customary caps plan reimbursement.** If the cash price is below what the plan would
  otherwise pay, the plan pays the cash price. So a cash price set too low quietly lowers *plan*
  revenue on the same drug — which is a real money lever pointing the opposite way to instinct, and
  it is why `cash-pricing` is on the money list.

### 5. Units, everywhere

The fault shape the brief already names, and it has now cost two phantom findings near $34,000 in
one session, both mine. A claim's quantity is in the dispensing unit — tablets, millilitres, grams —
and a pack description counts whatever the FDA chose to count, which may be syringes or tubes or
pouches. Wegovy: 2 mL against 4 syringes. Estradiol cream: 42.5 g against 1 tube, a 28-fold error
that silently disqualified an appealable claim.

Being fixed now: one function that gives the pack size **and its unit** and refuses when it cannot
tell. Refusing is the point — a null that says why is correct, a plausible number is the bug.

---

## Still to be checked, and I have not checked these yet

Written down so they are not lost, and so the next question is not "what else is there".

- **Partial fills and completion fills.** One prescription, two claims, one drug. Does the site count
  them as two fills? Does it double the cost?
- **Narrow therapeutic index drugs** — warfarin, levothyroxine, phenytoin, lithium. AB-rated is not
  the same as safe to switch mid-therapy, and a recommendation to change NDC on a stable patient is
  a clinical suggestion the site is not qualified to make.
- **Inhalers and nasal sprays are frequently not substitutable at all** — device-specific, often no
  AB rating. The `substitutable()` function requires a matching TE code, so this may already be
  right; it needs proving rather than assuming.
- **DAW codes.** The prescriber's "dispense as written" makes a substitution illegal regardless of
  economics. Is DAW on the claims feed, and does anything read it?
- **DIR fees** land months later and retroactively, per claim. The accrual treats them as a hand-typed
  line, so an empty line means nobody entered them rather than that there were none.
- **Credits reduce cost of goods in the month the credit lands**, not the month of the purchase.
- **Compounds have no single NDC** and cannot be priced or compared this way at all.
- **340B or contract-pharmacy claims** have entirely different economics; if any exist here they must
  not be mixed into margin figures.
- **Salt forms and esters** — same ingredient name, not the same drug.

---

## The end goal, and how a recommendation actually reaches him

He asked this directly: *"how can we present these tools or recommendations in best way for end
user (the site is somewhat busy), how can we make sure integrate into current routine so that
recommendations are actually read and understood by me at the right time so they can actually be
actionable."*

The goal is not a page of recommendations. It is that **the right thing to do arrives at the moment
he is already doing that kind of thing**, with the money on it and one press to act.

Which means recommendations belong at their moment, not on a dashboard:

| Moment | What he is doing | What belongs there |
|---|---|---|
| ~4pm, placing the order | choosing what to buy | buy this NDC instead, this pack size, from this wholesaler — with months-of-stock shown |
| Filling a script | at the counter | nothing. Never interrupt dispensing with economics |
| Once a week | working the list | MAC appeals over $30, returns closing, NADAC complaints |
| Month end | closing the books | adjustments, DIR estimate, what moved and why |
| A drug he is about to lose money on | before it is dispensed | the loss, the alternative NDC, and whether a plan would pay for it |

And three rules the site has repeatedly broken:

1. **One thing, not a list.** He has said he wants to be told the one thing worth doing today. A
   ranked list of six is a list nobody finishes.
2. **Say what it does not know.** "Cheaper per unit, but that is eleven months of stock" is useful.
   "Cheaper per unit" alone is a trap.
3. **The action is on the line.** Not a paragraph telling him to go to another screen.

## What has to be true before the first tool ships

In order, and none of them is optional:

1. Pack size and its unit, from one function, refusing where it cannot tell.
2. Divisible against whole-package known per NDC, so quantity advice is possible at all.
3. Units dispensed per month per NDC, so "cheaper per unit" can be weighed against holding it.
4. Equivalence that means substitutable *here* — TE code, DAW, and the forms that never substitute.
5. Every benchmark comparison reading `basis_of_reimbursement` rather than assuming one.
6. On-hand plus pack size, so "sealed" is a fact and not a proxy.

Then the tools he listed are worth building, and not before: buying above NADAC, supplier appeals,
MAC appeals, NADAC complaints, return tools, and choosing the NDC furthest under NADAC.
