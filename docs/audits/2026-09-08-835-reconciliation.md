# Audit — what `x12-835.ts` keeps, and what it drops

*Helper B, 8 September 2026. Asked for under "Helper B" in `docs/ASSIGNMENTS.md` (added 8
September): read `docs/BACKLOG.md` item 2b-ii for what a claim must carry to be matched to an 835
and what the 835 carries, then check what `x12-835.ts` keeps against that list and say what it
drops.*

**Everything below was produced by running the parser on a synthetic remittance of the right
shape, not by reading it.** I have never seen a real 835 — none exists in this repository — so the
shape is built from the 5010 X12 835 structure named in 2b-ii, and the figures are mine.

## The list from 2b-ii, and what survives

From the 835, item 2b-ii asks for: **N1\*PR payer name and id**, the **TRN trace**, **each CLP with
its CAS adjustment codes**, and **PLB provider-level adjustments** — *"money that belongs to no
single claim and must still reach the books."*

| 2b-ii asks for | `x12-835.ts` | Where it ends up |
| --- | --- | --- |
| N1\*PR payer **name** | ✅ `payer` | — |
| N1\*PR payer **id** | ❌ | dropped: `N1` reads `f[2]` only, so the `XV`/`87726` qualifier and id are lost |
| TRN trace number | ✅ `traceNumber` | — |
| BPR02 total, BPR16 date | ✅ `totalPaidCents`, `paidOn` | — |
| CLP01 our reference | ✅ `reference` → `rxNumber` + `fillNumber` | — |
| CLP02 status | ✅ `statusCode` | — |
| charged / paid / patient responsibility | ✅ | claim level only |
| CLP07 **payer claim control number** | ❌ | dropped; it is the number quoted when ringing the payer about a claim |
| NDC (SVC01 `N4:`) | ✅ `ndc11` | — |
| service date (DTM 472) | ✅ `serviceDate` | — |
| **CAS adjustment codes** | ❌ | segment lands in that claim's `raw[]` and is never parsed |
| **PLB provider-level adjustments** | ❌ | **worse than dropped — see below** |
| amounts **by component** (ingredient, fee, tax) | ❌ | `AMT` segments land in `raw[]`; no component split |

The claim-side items 2b-ii lists (the 503-F3 authorization number, BIN/PCN/group) are the PioneerRx
export ask, not this file's job — but they are the other half of the join and nothing carries them
yet either.

## 1. PLB is not merely dropped: it is filed under the last claim

**Severity: high, and it is money.**

The parse loop's `default` branch is `if (current) current.raw.push(seg)`. A `PLB` segment appears
after the last `CLP` and before `SE`, so `current` is still the final claim of the file — and the
provider-level adjustment is appended to **that claim's** `raw[]`. A DIR fee or a recoupment that
belongs to the whole remittance is recorded, verbatim and unparsed, against one unrelated
prescription.

Run on a remittance carrying `PLB*1234567890*20261231*CS:ADJ2026*-5750~`:

```
PLB            : NOT KEPT
PLB landed in  : the last claim's raw[]
CAS landed in  : that claim's raw[]
```

## 2. The remittance is not required to balance, and nothing notices when it does not

**Severity: high. This is where the money actually goes missing.**

`claim-payments.ts:280-289` banks the remittance and posts the claims from two different figures:

```ts
amountCents: r.totalPaidCents ?? out.amountCents,   // the cash receipt is BPR02
```

while `out.amountCents` is the sum of the CLP payments posted against fills. On a remittance with a
PLB adjustment those two are **not** the same figure, and both are right individually:

- **BPR02 is net of the PLB.** It is what actually hit the bank, so banking it is correct.
- **The CLP payments are gross.** Each claim really was adjudicated at that amount, so posting them
  is correct.
- **The difference is the PLB** — and it is recorded nowhere. Not an expense, not contra-revenue,
  not a line on any page.

A worked example. Twenty claims adjudicated at $4,000.00 gross, less a $57.50 DIR fee, so BPR02 is
$3,942.50:

| | |
| --- | --- |
| Cash receipt written | **$3,942.50** — correct |
| Claim payments posted | **$4,000.00** — correct |
| DIR fee reaching the books | **$0.00** — wrong |

The pharmacy's own cash is right and its claim-level revenue is right, and it is $57.50 better off
on paper than in the bank, every remittance, with nothing on any screen saying why. DIR is not a
rounding error for an independent pharmacy; it is one of the largest single deductions it faces.

**And the parser reports no problem.** On a file whose CLP payments do not sum to BPR02, `problems`
comes back **empty**:

```
BPR02 total    : (the file's own total)
sum(CLP paid)  : (the claims' total)
balances?      : false
problems       : []
```

There is no balance assertion anywhere. The parser's own docstring says the claim total wins
*"because that is the figure the remittance itself balances to"* — but nothing ever checks that it
balances. `docs/SESSION-RULES.md` requires every reader that decides money to be checked by
arithmetic before anything is stored; this one is not.

## 3. Without CAS, an underpayment cannot be told from a contractual write-off

**Severity: it disables the appeal case, which is what the site is for.**

`CAS*CO*45*2500` (contractual obligation, charge exceeds fee schedule) and `CAS*PR*3*2500` (patient
responsibility, copay) mean entirely different things about the same $25.00. The first is the payer
saying "our contract prices this lower" — the sentence a MAC appeal argues with. The second is
money the patient owes.

Today both land in `raw[]` and nothing reads either. So a claim that paid less than it should is
indistinguishable from one that paid exactly what the contract says, and the appeal queue cannot
tell which claims are worth appealing from the remittance — only from re-deriving the expected
price, which is the harder road and the one that needs the contract read first.

## What I would do, and why it is not mine to do

`x12-835.ts` and `claim-payments.ts` are not in my file group (`docs/ASSIGNMENTS.md` puts
`claim-payments.ts` inside Helper A's claims-data audit). This is a behaviour change to money that
is already being banked, so it is a finding, not a patch. The shape I would suggest:

1. **`providerAdjustments: { code, reference, amountCents }[]` on `Remittance`**, parsed from PLB
   (which repeats its reason/amount pairs across elements 4 onward), and **removed from the last
   claim's `raw[]`** so it is not filed against a prescription it has nothing to do with.
2. **`adjustments: { group, reasonCode, amountCents }[]` on `RemittancePayment`**, parsed from CAS
   (also repeating: group, then up to six code/amount/quantity triples).
3. **A balance check that is a `problem` when it fails**: `sum(CLP paid) + sum(PLB) === BPR02`. A
   remittance that does not balance is the one thing a reader of money must never accept quietly.
4. **`payerId` from N1\*PR `f[4]`, and `payerControlNumber` from CLP07.**
5. **The PLB total must reach the books** as its own line — a fee, not a reduction of any claim's
   revenue — so the cash and the accrual sides can both be right and the difference has a name.

Item 3 is the one worth doing first even alone: it converts a silent hole into a stated problem,
and it needs no schema change.

## Questions that need the real database

Every figure above is from a synthetic file. Three things would size it, and the first two need
only counts:

1. **How many 835s has the site read, and did any of them balance?** For each stored remittance:
   BPR02 against the sum of the claim payments recorded from it. Any row where those differ is a
   PLB (or a parse gap) that went unrecorded. `claim_payments` groups by `reference`, whose first
   half is the trace number.
2. **Do the pharmacy's payers actually send PLB?** If none of them do, findings 1 and 2 are
   theoretical for now and finding 3 is still real. If Caremark or ESI do, this is live money.
3. **A single real 835, with the identifiers changed** (`fixtures/README.md` rules — every Rx
   number, NPI, member id and payer id replaced), would let all of this be tested against a real
   file instead of my reconstruction. There is none in the repository today.
