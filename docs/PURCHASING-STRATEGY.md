# Buying, holding and returning: the logic the site is built on

Written for the question that produced it: *"these are the games pharmacies have to play … help find
the best way to play them all so it improves our profit, and keeps our inventory lean."*

Everything here is one question with several faces, and the faces contradict each other. Buying deep
earns discounts and ties up cash. Running lean frees cash and risks a lost sale. Moving spend to a
cheaper secondary saves on the invoice and can cost a rebate band worth more than the saving. There
is no setting that makes all three right at once, so the site's job is not to pick one — it is to
put the three numbers next to each other at the moment the decision is made.

## The chain, end to end

    what was dispensed  ──▶  units per day  ──┐
    (claims, as fills)       (usage.ts)       │
                                              ├──▶  days of stock  ──▶  order this / return that
    what is on the shelf ─────────────────────┘         (lean-shelf.ts, order-plan.ts)
    (a daily count, on-hand.ts)

    what each supplier charges  ──▶  effective cost  ──▶  who to buy it from
    (catalogues)                     (less the rebate, product-ledger.ts)
                                              │
    what the plan pays  ─────────────────────┘
    (NADAC + dispensing fee, or the plan's own rate)

Six numbers, and until now four of them lived on separate screens and two did not exist at all.

## The five games, and how each is played here

### 1. The order minimum

A secondary is cheaper on eleven items and will not ship under $500. The eleven come to $180.

Three ways out, and only one is a decision:

- Buy the eleven at the primary. Certain, and loses the saving.
- Pad the order to $500 with whatever reaches it. Meets the minimum and buys a freezer.
- Find what *else* that supplier is cheapest on that moves fast enough that a fortnight of it is
  not a freezer.

The site does the third. Candidates are ranked by **saving per dollar committed**, not by saving —
the shortfall is a budget, and the question is which items return most per dollar of cash that has
to sit on a shelf. Each is capped at fourteen days of *measured* movement, and refused outright on
anything with no velocity, on anything whose apparent rate is one large fill rather than a rate, and
on short-dated lots. Where the shortfall cannot be filled honestly, it holds and says so. It never
invents a basket to reach a number.

### 2. The rebate band, which overrules the invoice

This is the one that quietly reverses everything else.

McKesson's compliance ratio is the generic share of what the pharmacy buys there. The ratio picks a
band; the band's rate is paid on **the whole period's contract generics**, months later, on a report
nobody connects back to a Tuesday-morning ordering decision. So a generic bought $14 cheaper at a
secondary is not $14 cheaper — it is a generic that did not go through the primary, and if it was
the purchase that would have carried the month over a band edge it can cost several hundred.

The site prices every basket as the difference between two worlds: what the primary pays if the
basket is bought there, against what it pays if it is not. Where that difference is negative and
larger than the invoice saving, the verdict flips to **buy it at the primary**. Where the ratio,
the ladder or the period's purchases are not on file it says *not known* — never *nothing*, because
"nothing" is exactly the wrong answer to give when the thing that would have priced it is missing.

The same arithmetic runs the other way: a brand bought at a secondary *raises* the primary's generic
share, and can be worth doing at a higher price for that reason alone.

### 3. Lean, and what lean costs

The target is one to two days. Against that:

- **short** — under target, with movement. A lost sale waiting to happen.
- **lean** — at target and up to twice it. The position to be in; not shown, because it needs nothing.
- **overstocked** — beyond that. A quantity mistake; comes back to the same supplier next week.
- **dead** — nothing dispensed in the window at all. A *stocking* mistake. Kept separate from
  overstock deliberately: they need opposite handling, and a list that merges them reports the same
  urgency for both, which is how the dead lines quietly expire.

Ordered by money at risk, never by days of stock. A thousand days of a $4 bottle is a rounding
error; three days of a GLP-1 is four thousand dollars.

### 4. Returns, on the invoice clock

Not the expiry date. McKesson credits a saleable return in full within thirty days of the **invoice**
and three quarters after that, and nothing about remaining shelf life enters into it. A site counting
down to expiry would talk about a bottle with eighteen months on it and say nothing about the one
whose full credit runs out on Friday.

So each surplus line carries: what it credits today, what it falls to, and the last day to raise the
authorisation. Where no policy is on file for the supplier, no window is invented — a return raised
outside a made-up window is a return refused with the stock still here.

### 5. Where the margin actually is

Two different questions that look like one:

- **Am I buying it well?** Effective cost against NADAC. Under NADAC is the good side.
- **Is it worth dispensing?** What the plans actually paid against what it actually cost.

A drug bought well below NADAC can still dispense at a loss where the plan pays under acquisition,
and a drug bought above NADAC can be the best margin on the shelf. On a NADAC-plus-fee plan the gap
between NADAC and cost *is* the margin, so the buy list ranks by the gap and never by the price — a
dear NDC with a high NADAC beats a cheap one with a low NADAC.

## What still has to come in, and what does not

**Already in, needing nothing new:** velocity, margin per drug, effective cost per supplier, NADAC,
the rebate ladders and the ratio, return policies, invoice history.

**The one real gap, now filled:** the daily on-hand count. Everything about days of stock, lean
targets, return sizing and "how much do I actually need" was a guess without it.

**Worth adding next, in order of what each unlocks:**

1. **On order but not yet received.** Today an order placed this morning is invisible, so the same
   shortfall is ordered twice. Cheap to fix once a purchase order exists in the site.
2. **Lot expiry dates from the on-hand file**, where PioneerRx can include them. Turns "this is
   surplus" into "this is surplus and it expires in March", which changes the urgency completely.
3. **Each secondary's return policy.** Two are on file; the buy list will not recommend buying deep
   at a supplier whose return terms are unknown, so every missing policy costs real discounts.
4. **Which plans pay NADAC-plus-fee and which do not**, per BIN/PCN. Partly derivable from the
   claims already held — where reimbursement tracks NADAC across many fills, that is the answer.

## Supplier catalogue and ordering integration: what actually exists

The short answer is that **REST APIs are not how this industry connects, and that is fine, because
the file-based routes do everything needed here.**

- **EDI is the real standard.** Wholesalers exchange price/catalogue files (X12 **832**), purchase
  orders (**850**), acknowledgements (**855**), shipment notices (**856**) and invoices (**810**).
  Every major wholesaler supports it and most pharmacy management systems can speak it. This is what
  "wholesaler integration" means in practice.
- **McKesson Connect has a Data Exchange tool** that covers exactly the two directions needed:
  *Price/Product Export* (the catalogue and this pharmacy's contract pricing, out) and *Purchase
  Order Import* (an order built in another system, in). That second one is the important one — it
  means the site can produce the order and McKesson will take it, without any API access at all.
- **A direct McKesson API exists** for catalogue, availability, order submission and tracking, but
  access runs through account management and an integration agreement rather than a self-serve
  developer signup. Worth asking the rep about; not worth waiting for.
- **PioneerRx is already the aggregator.** Its Supplier Catalog export carries roughly two dozen
  suppliers' prices in one file, which is what this site reads today. For a single independent that
  is a better integration than any one wholesaler's API, because it is the only source that puts
  every supplier on the same page.
- **Secondaries** (IPC, ParMed, and the rest) are generally web ordering plus a scheduled price
  file. The price file is the part that matters and the site already reads it.

**Never automate the ordering portals.** McKesson's and Cardinal's terms of use explicitly prohibit
bots and scrapers, and the others should be assumed to say the same. A scraped order is an account
at risk for a saving the sanctioned file routes give anyway.

**The practical recommendation:** do not chase an API. Ask McKesson for Data Exchange access
(Price/Product Export and Purchase Order Import), keep the PioneerRx catalogue export arriving on
schedule, and ask each secondary for a scheduled price file to the same mailbox. That gives prices
in automatically and orders out automatically, which is the whole of what an API would have bought.

The exact questions to put to each rep — McKesson, Anda, ParMed/Cardinal and the rest, with the
transports, file specs and identifiers to ask for — are already written out in
[`questions-suppliers.md`](./questions-suppliers.md). That is the call list; this is the reason for it.

## What the site does with all of it today

| Screen | Question it answers |
| --- | --- |
| Purchasing → Today's order | What to buy, from whom, whether the minimum is met, and what to add if it is not |
| Purchasing → The shelf | Days of stock, what is surplus, what it credits, and by when |
| Inventory → What to send back | Every returnable invoice line on the invoice clock, surplus or not |
| Suppliers → *supplier* → terms | The ladders, the return policy, and now the order minimum, freight and lead time |
| Money → Monthly profit and loss | What all of it came to |
