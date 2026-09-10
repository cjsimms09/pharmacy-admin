# A fill that is sold and then returned, and the codes on an 835

**10 September, Helper B (cloud).** The owner asked three things:

> *"A claim gets submitted and sold then gets returned. How do we handle this from a claim
> perspective, from an 835 perspective, from a money perspective. I also want to make sure we have
> a way to understand codes that come over on 835s. How do we handle them, both in terms of claims
> and profit or bookkeeping. Have we searched all the contracts and manuals we have to make sure we
> can understand all the different codes?"*

This is what the code does today, traced rather than assumed, and where it is wrong. **I cannot see
the pharmacy's database, its contracts or its manuals**, so the last question is answered from what
the repository holds about them, and the counts are queries for the machine.

Short answers, before the detail:

1. **A reversal before pickup is handled correctly.** A return *after* the sale is not: it silently
   rewrites a month that has already been reported, and the date needed to do it properly is stored
   and never read.
2. **A payer's own reversal on an 835 cannot attach to the claim it reverses**, by an explicit rule
   that is right for every other case.
3. **No code on an 835 is understood by this site.** Claim-level CAS adjustments are parsed and
   dropped; CLP02 decides a single word in a skip message; remark codes are not read at all; PLB
   codes reach a sentence and no account. Nothing anywhere can say *"I do not know this code"*.
4. **The contracts have not been searched for codes, and could not be**: there is no field in the
   extraction that holds the code a fee is printed under. That join is the whole of BACKLOG 2b-v.

---

## Part 1 — sold, then returned

### The two events are not the same, and only one of them is handled

**Reversed in the bin, never collected.** The script is transmitted, sits in will-call, nobody comes
for it, and it is reversed after a fortnight. Since `a19d100` this is right: revenue is counted on
the day of collection, so a fill with no completed date was never in any month's revenue and its
reversal changes nothing that was ever reported. `profit-and-loss.ts` names it on the account as
stock still on the shelf. Nothing below applies to this case.

**Sold, then returned.** The patient took it away — `completedAt` is set, the fill was revenue in
that month, its acquisition cost was cost of goods in that month — and the claim is reversed
afterwards, in a later day's transaction report. This is the owner's question and it is not handled.

### The claim side is sound

The feed carries paid, reversal and resubmission as three rows (`schema.ts:2111`). A reversal does
not delete the claim: the row stays, `status` becomes `reversed`, `reversedOn` is set,
`reversalKey` records which report row did it so a re-sent day is recognised
(`claims.ts:453-489`). Reversals matching nothing held are stored as unmatched rather than counted
as a loss (`data-dictionary.md:113`), and `claims.ts:671` sweeps up stranded ones. This part is
careful and I found nothing wrong with it.

### The accrual side rewrites a month that has already been reported

`groupIntoFills` drops every reversed row with no test of when it was reversed:

```ts
// A reversed row is not revenue, and a reversal matching nothing held is not a loss either.
if (c.status === "reversed") continue;                                    // fills.ts:360
```

So the fill leaves the account **in the month it was sold in**, not the month it came back in. A
return in September removes revenue and cost from August. August's books are not restated with a
note; they simply produce a different number the next time anybody looks, and nothing on the page
says a figure moved or why.

**`reversedOn` is written and never read.** It exists on the claim (`schema.ts:2162`), it is set on
every path that reverses one, and no query, page or calculation in the site reads it — the only
matches are the four writes. It is the exact shape of the trap `252d37c` names for `evoucherCents`:
a stored column nothing reads. Here it is not a component of something else, it is simply unused,
and it is the one field that would let a return be booked in the period it happened.

Whether a return should be booked in the original month or the month it came back is an accounting
decision, not a coding one, and both are defensible — but *silently* restating a closed month is
not either of them. At minimum the account should say so.

### The 835 side cannot attach the payer's reversal to the claim it reverses

When the plan takes its money back it does so in one of two ways, and the site treats them
differently.

**As a negative claim payment.** A later 835 carries CLP with status 22 and a negative CLP04.
`payableOnly` keeps it deliberately and says why — *"A reversal is real and negative, and is kept —
it takes back a payment that was counted"* (`x12-835.ts:447`). Then `recordClaimPayment` looks for
the claim, and `findClaim` refuses to match a reversed one:

```ts
const rows = all.filter((r) => r.status === "paid");
if (rows.length === 0) return { claim: null, onlyReversed: true, ambiguous: null };   // claim-payments.ts:131
```

That rule is right, and it was right to add it — a plan *settling* a fill the pharmacy had reversed
must not attach to the reversed claim. But it is applied to every payment, and a reversal is the one
kind where the reversed claim is exactly the right home. So the negative payment is filed against no
claim, with the note *"The only claim this pharmacy holds for that fill was reversed... Worth asking
the plan what it paid for."* — an invitation to ring the plan about a takeback the site could have
explained itself. The discriminator is already parsed and already thrown away: CLP02.

**As a provider-level takeback.** A WO (overpayment recovery) or FB (forwarding balance) in a PLB
segment recovers the money from the whole remittance instead. The parser reads it
(`x12-835.ts:210`), the balance check uses it, and the receipt sentence names it — and then says, in
the site's own words, *"That money is not yet on either account"* (`claim-payments.ts:390`). It is
correct that it says so. It is still money the books do not have.

### The money side is asymmetric, and the asymmetry reads as a receivable

- **Cash.** A remittance dropped in or arriving by mailbox banks its own total (`bank: true`), and
  BPR02 is already net of anything reversed inside it. The facilitator's sweep does not bank, and
  its payments are read directly, but only `source === "mtf"` — `profit-and-loss.ts:877`. A plan's
  own 835 money reaches the cash account through the deposit and through nothing else. On this side
  a return roughly handles itself.
- **Accrual.** The fill vanishes from its original month, as above.

So after a return the two bases disagree by the fill, and `basisGap` reads that difference as
*"earned less banked — what is still owed to the pharmacy"* (`ledger.ts:314`). A return therefore
shows up as a receivable that will never arrive, in the opposite direction from the truth.

### And the drug itself

`product-ledger.ts:250` and `usage.ts:188` skip reversed rows, so the units leave the usage history
retroactively too — the same silent restatement, in the buying figures rather than the money ones.

This one needs a decision before any code: **a drug that has left the pharmacy with a patient
generally cannot go back on the saleable shelf.** If that is so here, then on a sold-and-returned
fill the acquisition cost is a *loss* and not returned inventory, and removing both the revenue and
the cost — which is what happens today — overstates the month by exactly the cost of the drug. If
some categories can be restocked, the two cases have to be told apart. Nothing in the site
distinguishes them today, and the Kansas rule belongs with the manual work rather than in a guess
from here.

---

## Part 2 — the codes on an 835

### Six code families arrive, and one of them is understood

| where | what it says | what the site does |
|---|---|---|
| **CLP02** claim status | 1 primary, 2 secondary, 3 tertiary, 4 denied, **22 reversal of previous payment**, 25 predetermination | parsed (`x12-835.ts:337`), used for **one word** in a skip message when the payment is zero (`:458`) and nowhere else |
| **CAS group** | CO contractual, PR patient responsibility, OA other, PI payer initiated, CR correction | parsed into `adjustments[]` (`:368`) and **read nowhere in the codebase** |
| **CARC** reason (CAS03…) | *why* the payer paid less — write-off, copay, deductible, coverage | same: parsed, dropped |
| **RARC** remark (LQ/MOA/MIA) | the payer's explanatory notes | **not parsed at all** — falls to `default:` and is kept only in the raw text |
| **PLB** reason | WO recovery, FB forwarding balance, L6 interest, CS adjustment, 72 authorised return, and the payer's own reference | parsed with its reference (`:210`), summed into one figure, named in a sentence, **on no account** |
| *(claim side)* NCPDP reject | why a transmission was rejected | the R status is counted; the reject code is not in the schema |

I checked for a lookup table of any of these: there is none. `grep -rn "CARC\|RARC" src/` matches
**nothing at all** — the two acronyms appear only in `docs/BACKLOG.md` and `docs/PLAN.md`, where the
work is described — and "reason code" in `src/` matches one file, `x12-835.ts`, only in prose. Every
code in the site is a bare string that is compared to nothing.

### What that costs, in the two places the owner named

**Claims.** Without CLP02 the site cannot tell a payment from a takeback, which is finding 3 above.
Without the CAS group it cannot tell the patient's share from a contractual write-off, so it cannot
answer "did this plan pay what the contract says" — the money that was written off against the
money the patient still owes are two completely different findings, and both are currently the same
absence of money.

**Bookkeeping.** Every adjustment on an 835 has to land under a heading, and the headings are not
interchangeable: a contractual write-off is not revenue and never was; a patient-responsibility
amount is a receivable from the patient; a DIR fee is a cost of goods against the fill; a
transaction fee is an operating cost; a recoupment reverses an earlier month's revenue; interest is
income. Today all six land in the same place, which is nowhere, and the receipt sentence tells the
owner that in words each time.

### The rule this site already lives by decides the design

*Nothing is inferred where a document could say it.* The CARC and RARC lists are published and
maintained externally and change three times a year; the PLB codes are in the 835 implementation
guide. **A dictionary written from memory is exactly the inference this repository forbids**, and I
am the wrong side of the wall to fetch one — my network reaches GitHub and the package registries
and nothing else. So the honest shape is:

1. A code table with a **provenance on every row** — which published list, which version, when it
   was loaded — kept as data rather than as literals in the source.
2. An **explicit unknown path**. A code the table does not hold must produce a visible "this
   adjustment is not understood, and $X of it is unclassified on this remittance", in the same
   spirit as the balance check that already refuses to post a file that does not add up. This is
   the owner's *"identify when we don't or when something is wrong"*, and it is the part that
   matters more than the table: a dictionary that quietly maps an unknown code to "other" is worse
   than none.
3. **Arithmetic before storage**, as everywhere else here: the classified adjustments plus the paid
   amount must reconcile to the charged amount per claim, and the claim total less the provider
   adjustments to BPR02 — which the reader already checks and refuses on.

---

## Part 3 — the contracts, and why the search cannot have happened

BACKLOG 2b-v records the owner asking this on 8 September and assigns the dictionary to me, with the
extraction side to session 1. The contract reader today extracts, with a citation each,
`transactionFees[]` (name, amount, appliesTo), `postPointOfSaleDiscounts[]` (name, trigger,
calculation, collectionMethod, frequency) and `dirFeeBasis` (`contract-terms.ts:117,196,339`).

**Not one of those shapes has a field for the code the fee is printed under.** So even where a
contract says "L6 — TRANSACTION FEE" or names its DIR under a code the remittance will use, the
reader has nowhere to put it, and the join BACKLOG 2b-v describes — standard code set, then this
PBM's contract-named fee — has no key on the contract side. That is a one-field change to
`TransactionFee` and `PostPointOfSaleDiscount` plus a line in the extraction prompt, and it is
session 1's file.

So: **no, the contracts have not been searched for codes.** They could not have been, and re-running
the extraction as it stands would not find them. The manuals are in the same position — I have no
sight of what the pharmacy holds, and nothing in the repository indexes a payer manual.

---

## What I propose to build, and what is not mine

**Mine, and buildable without the real data** — pure modules with fixtures, in my own file group:

1. The classification frame: a pure function from (group code, reason code, level, amount) to a
   bookkeeping heading, with the unknown path as a first-class result rather than a fallback, and
   the per-claim and per-remittance arithmetic checks around it.
2. The reversal rule as a pure decision: given CLP02 and the sign, is this a payment, a takeback or
   a denial, and which claim does it belong to — so the "never a reversed claim" rule can gain its
   one exception without anybody guessing at the seam.
3. The code table's *shape* and loader, with provenance, so the published lists can be dropped in on
   the machine and proved against a real 835.

**Not mine.** `claim-payments.ts` and `x12-835.ts` are importers, `profit-and-loss.ts` and
`fills.ts` are money logic, `contract-terms.ts` is session 1's extraction. Every finding above lands
in one of those, so this document is the whole of my delivery on them until somebody says otherwise.

## What needs the real data

Queries for the machine, added to the list under "Open items" in `HANDOFF.md`:

- how many claims are reversed with a `completed_at` set — that is the size of the sold-and-returned
  case, and it decides whether any of Part 1 is urgent;
- of those, how many were reversed in a later month than they were sold in, which is the count of
  months that have silently changed;
- how many `claim_payments` rows are negative, and how many carry no `claim_id`;
- every distinct CAS group and reason code, and every PLB reason code, across the 835s already
  read, with a count and a total for each — the actual dictionary this pharmacy needs, as opposed to
  the whole published list;
- whether any contract already names a code beside a fee, on a sample the extraction has read.

And still, from 8 September and still unanswered: **one real 835 with the identifiers changed** per
`fixtures/README.md`. Every figure in this document is read from the code and from files I built to
the 5010 shape myself.
