# Audit — the claims feed: `claims.ts`, `rx-transactions.ts`, `reimbursement-rules.ts`, `reimbursement-fit.ts`

Helper A, 8 September. Audited against session 1's claims inventory (HANDOFF, 8 September): what the
daily transaction report actually carries, and what it does not. One meaning and one unit per
figure; nothing inferred that the export states; every figure the profit chain uses traced to the
column it came from.

Two findings, and they are the same missing column seen from opposite sides — one module refuses to
work without it, the other works without it anyway. Plus one correction to the inventory.

---

## 1. No claim from the live feed can ever be priced against NADAC

**Severity: high. A money check that silently does nothing is worse than one that is absent, because
nobody goes looking for it.**

`claims.ts:417`, on the transaction-report path — the feed that actually runs:

```ts
quantityThousandths: t.quantityThousandths, quantityUnit: null,
```

Hard-coded null, correctly, because the inventory confirms the export carries no quantity unit. But
`reimbursement-rules.ts:215`:

```ts
const priceable = nadac !== null && claim.quantityThousandths !== null
  && claim.quantityThousandths > 0 && claim.quantityUnit === nadac.pricingUnit;
```

`null === "EA"` is false. **`priceable` is false for every claim on this feed, always.** So `floor`
is null, `shortfallCents` is null, and the Kansas Medicaid floor analysis — the check that finds
claims paid below what the state requires — computes nothing at all on 100% of the claims.

The refusal itself is right: pricing a per-EA quantity against a per-ML benchmark is wrong by orders
of magnitude, and `unit_of_measure_agrees` says so honestly ("The claim carries no unit of measure").
The fault is that a check which never fires reads exactly like a check that fires and finds nothing.

The line directly beneath it shows the same problem was fixed once already for a different column:

```ts
// The report now carries it; without it no contract rate written per days-supply band applies.
daysSupply: t.daysSupply,
```

Days supply was got into the export. The unit of measure was not.

**What to do, in order of soundness.** The export can carry it —
`docs/reference/pioneerrx-support-request.md` already lists quantity unit among the columns to ask
for, and this is the argument for asking: without it the floor check is dead. Until then, the honest
interim is **not** to guess a unit per claim but to say out loud, once, on the reimbursement screens,
that no claim is being priced and why — one sentence beats 1,081 blank shortfalls.

I did not implement a derived unit. It could be taken from the NDC's own pack unit where the
catalogue and NADAC agree, and that would price most claims — but a shortfall figure drives an
appeal, and an appeal filed on an inferred unit is withdrawn. SESSION-RULES §4: *nothing is inferred
where a document could say it*, and a document can.

**Query for session 1:**

```sql
select count(*) as claims, count(quantity_unit) as with_unit from claims;
-- Expect with_unit = 0 on the transaction feed. If it is not zero, some other importer fills it
-- and those claims are the only ones the floor has ever been computed for — worth knowing which.
```

## 2. `reimbursement-fit.ts` makes the comparison `reimbursement-rules.ts` refuses to make

**Severity: medium-high. It infers how a payer prices, from ratios it cannot know are commensurate.**

`reimbursement-fit.ts:95`:

```ts
const perUnit = (c: FitClaim) => (c.ingredientPaidCents * 10_000) / (c.quantityThousandths / 1000);
```

then, at lines 101 and 108, that figure is divided by `nadacUnitMicros` and `awpUnitMicros` to fit a
formula — "this payer pays NADAC + k%". **The string `quantityUnit` does not appear anywhere in the
module.** No guard, no check, no mention.

So the site holds two opposite positions on the same unknown: `reimbursement-rules` will not price a
single claim without the unit, and `reimbursement-fit` fits a pricing formula across every claim
regardless. One of those is wrong and it is not obvious which — but they cannot both be right, and
the inconsistency is invisible because they are read on different screens.

In practice the two units usually agree: PioneerRx bills in the product's NCPDP billing unit, which
is the unit NADAC prices. The risk is the minority where they do not, and a fitted percentage is
exactly the shape that a few wrong ratios distort — a median resists outliers, but `spreadPoints`
(the IQR the fit reports as its own confidence) widens, so the fit looks *less* certain rather than
wrong, and nobody investigates a wide spread.

**Recommended:** whichever way the lead settles it, both modules should take the same position and
say so in one place. If the unit is unknowable, `reimbursement-fit` should report its formula with
the same caveat `reimbursement-rules` prints, rather than silently proceeding.

**Query for session 1:**

```sql
-- Where a claim's NDC is priced by NADAC in something other than each, the ratio the fit uses is
-- the one most likely to be incommensurate. How many claims, and which payers?
select n.pricing_unit, count(*) as claims, count(distinct c.bin) as bins
from claims c join nadac_prices n on n.ndc11 = c.ndc11
where c.status = 'paid' group by n.pricing_unit order by claims desc;
```

## 3. A correction to the claims inventory: the export does carry a dispensing fee

The inventory lists the report's columns as rx, fill, status, amount, group, network id, copay,
total, date filled, BIN, tax, quantity, acquisition, PCN, NDC, gross profit and days supply, and
says `ingredientPaidCents` is "derived on that feed as remit + copay − dispensing fee" — which
reads as though the dispensing fee comes from somewhere else.

It does not. `rx-transactions.ts:210` positions it as a column of the report itself
(`dispensingFee: 6`), read at line 777 beside remit and copay. So the derivation is arithmetic on
three stated columns, not an inference.

**And the arithmetic is right**, which is worth recording because it looks wrong at a glance: adding
the patient's copay to work out what the *plan* paid for the ingredient. It follows from the NCPDP
identity — the amount remitted is already net of the patient's share, so

```
remit = ingredient + dispensing fee − copay   ⇒   ingredient = remit + copay − dispensing fee
```

Checked and sound. Worth a line in the data dictionary so the next reader does not have to derive it
again.

---

## What else I checked and found sound

- **Every figure the profit chain uses traces to a stated column.** remit → amount; copay → copay;
  patient total → total; acquisition → acquisition cost; quantity → quantity; gross profit → gross
  profit (read but, correctly, never used for margin — `fills.ts` recomputes it, which is what makes
  the secondary-payor fix possible at all).
- **The PCN is upper-cased on the way in** (`rx-transactions.ts`), because PioneerRx prints it as
  typed and a processor control number is not case-sensitive. Without that, one plan's claims split
  in two.
- **The BIN, quantity, NDC and date cells are shape-checked before a row is accepted**, and a row
  that fails is named rather than dropped silently.
- **`quantityThousandths` is thousandths throughout** — parsed once in `parseQuantityThousandths`,
  divided by 1,000 wherever a real quantity is wanted. The suffix is honoured everywhere I read it.
- **`networkId` survives the import intact** and is what the contract match now runs on.
