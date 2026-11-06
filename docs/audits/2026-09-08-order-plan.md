# Audit — `order-plan.ts` (the order itself)

Helper A, 8 September. Read against `docs/reference/buying-logic.md` and SESSION-RULES §4.

Three findings, all about the same idea the module states plainly and then does not carry through:
**a short-dated lot is not a price.** It is stock expiring inside the return window, and the module's
own header says it "will not recommend short-dated stock as a bulk buy". The sort honours that. Three
places upstream and downstream of the sort do not, and each costs money in a different direction.

All three are fixed in the marked commit on this branch, with tests.

---

## 1. A supplier's sound lot was thrown away because it also had a short-dated one

**Severity: high, and it is the one with an arithmetic demonstration.**

`offersFor()` reduces each supplier to one representative offer:

```ts
const held = best.get(o.supplier);
if (!held || o.effectiveUnitMicros < held.effectiveUnitMicros) best.set(o.supplier, o);
```

Cheapest wins, regardless of kind. So a wholesaler carrying **both** an expiring lot at 4c **and** a
good lot at 10c is represented by the 4c one — and the sort below then pushes that supplier to the
back for being short-dated. The 10c lot never enters the comparison at all.

Run against the real function, before the fix:

```
ranked:
  ANDA    11.00c  good lot
  Smith    4.00c  SHORT-DATED
→ the order goes to ANDA at 11.00c
```

Smith's sound 10c lot was the cheapest honest price on the table and was invisible. **Ten per cent
overpaid on every line where a supplier happens to stock both.**

**Fixed:** a supplier is represented by its cheapest *sound* lot; a short-dated lot represents it
only when the supplier has nothing else.

## 2. The saving was measured against a price the planner would never pay

**Severity: high. It moves the verdict on a whole basket.**

```ts
const pick = ranked[0];
const next = ranked[1] ?? null;   // ← may be short-dated
```

`savingCents = alternativeCost − ourCost`, and the alternative was whatever came second — including a
short-dated lot the module refuses to buy. Wrong in both directions:

- **A cheap expiring alternative made a sound pick read as a loss.** Smith sound at 10c against
  ANDA expiring at 4c gives a *negative* saving on a correct decision. That figure is summed into
  `basket.savingCents`, which `verdictFor` reads — so it can flip the recommendation on the basket.
- **Where the pick was the only sound lot**, the pharmacist was quoted a saving against stock nobody
  would have bought.

**Fixed:** the alternative is the next offer of the same kind — sound against sound, and where every
lot on the market is expiring, short-dated against short-dated. Where there is no comparable
alternative the answer is `null` and the saving is nought, rather than a number that means nothing.

## 3. A need filled from an expiring lot said nothing about it

**Severity: medium. Not wrong, but silent about a decision.**

A *top-up* that is short-dated is refused outright — correct, that is a bulk buy. A *need* is not
refused, and should not be: the drug is wanted and this may be the only lot anybody has. But the
line said only "Short 30 and the pack is 100, so this is exactly the need", with nothing to say the
pharmacy was committing to stock that expires inside the window it could have returned it in.

**Fixed:** the line now names the lot and says it expires inside the return window. The decision
stays the pharmacist's; it is no longer discovered on delivery.

---

## What I checked and found sound

- **`packsFor`** — `ceil(thousandths / (packQty × 1000))`. Thousandths over units-per-pack, rounded
  up. Zero units is zero packs; anything else is at least one. Correct, and the units line up.
- **`packCostCents`** — `effectiveUnitMicros × packQty × packs / 10,000`. Micros per unit × units ÷
  micros-per-cent = cents. Correct.
- **`alternativeCostCents`** is priced on the same units the pick buys, not on the alternative's own
  pack rounding — so the comparison is of prices rather than of pack sizes, exactly as its comment
  claims. Units check out: micros × thousandths ÷ 1,000 ÷ 10,000 = cents.
- **Freight is subtracted from the basket's saving**, not from each line, which is right: it is paid
  once per order and attributing it per line would make a two-line basket look twice as expensive.
- **Top-ups are capped by velocity, not by discount** — `maxDaysOfStock` days of what the claims show
  actually moves, and refused outright on an item with no rate. That is the rule that keeps the
  strategy honest and it is implemented as stated.
- **`unfilled` names the NDC and the reason** rather than dropping it, so a need nobody can supply
  is visible rather than absent.

## What I did not check

`verdictFor` and `topUpCandidates` beyond reading them for the above. They deserve their own pass;
nothing in them contradicted the doctrine on the read, but I have not traced their arithmetic the way
I traced the three findings.

## Query for session 1

```sql
-- How many lines the first finding was costing: NDCs where one supplier has both a short-dated and
-- a sound lot, and another supplier's sound price sits between them.
select ndc11, supplier,
       sum(case when availability like '%hort%dated%' then 1 else 0 end) as short_dated_lots,
       sum(case when availability is null or availability not like '%hort%dated%' then 1 else 0 end) as sound_lots
from supplier_items
group by ndc11, supplier
having short_dated_lots > 0 and sound_lots > 0;
```

Every row that returns is a supplier whose sound price was invisible to the order screen.
