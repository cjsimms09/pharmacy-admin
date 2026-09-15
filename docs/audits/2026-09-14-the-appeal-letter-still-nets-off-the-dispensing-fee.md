# The appeal letter still nets off the dispensing fee, and says on its face that it has not

14 September 2026 · helper B (cloud) · audit of `a285cb0`, *"Route a below-cost claim to the one
remedy that fits it"*.

**This is not a fault in `a285cb0`.** It is older than that commit. But `a285cb0` is what makes it
visible and what makes it matter now, because since this morning the site computes the below-cost
shortfall two different ways for the same claim, and the one that goes to the PBM is the wrong one.

---

## First: `a285cb0` itself, checked

I checked the new arithmetic against the identity it rests on and against every other place in the
codebase that decides a claim lost money. **Nothing wrong with it.**

- `ingredientReceivedCents` (`claim-remedy.ts:176-185`) inverts `remit = ingredient + fee − copay`
  to `ingredient = remit + copay − fee` correctly, prefers the adjudicated figure, and returns
  `null` rather than `0` where neither is available — which is rule 5 being kept.
- `mac-appeal-store.ts:142` maps before it filters, so a fill with no reimbursement figure still
  falls out rather than entering the worklist as zero.
- The dead fourth remedy the commit message describes — below cost **and** bought well implies the
  plan paid under NADAC, so the fourth branch could never fire — is real, and the invariant test
  now holds it.
- **Nowhere else has the same fault.** `fills.ts:526` already built revenue as
  `remitCents + patientPaidCents + laterPaymentsCents`, so the accounting side never understated a
  margin. `claims.ts:1175`'s below-cost list runs on `grossProfitCents`, which is PioneerRx's own
  `GrossProfit` column (`claims.ts:265`), not a figure this site derives. `claims.ts:1680` counts
  off `marginCents`, which comes from `fills.ts`. Three other paths, all already right. Checked.

## The finding

```
OBSERVATION: The PDF filed with the PBM computes what the pharmacy received as
             `receivedCents = c.planPaidCents + c.copayCents` (mac-appeal-evidence.ts:97), and both
             of its callers pass the plan's whole remittance into that first term —
             scripts/mac-appeal-evidence-one.ts:71 and scripts/mac-appeal-evidence-pdfs.ts:79, both
             `planPaidCents: Number(remit_cents)`.

             By the identity a285cb0 established and measured — mac-appeal-store.ts:64, holding on
             1,523 of 1,594 September fills — `remit = ingredient + fee − copay`, so
             `remit + copay = ingredient + fee`. The dispensing fee the plan already paid is inside
             "Total received".

             The document then prints, in bold (mac-appeal-evidence.ts:136-141):

                 Plan paid:              $<remit>
                 Patient copay:          $<copay>
                 Total received:         $<remit + copay>
                 Acquisition cost:       $<cost>
                 Reimbursed below cost by $<cost − remit − copay>, before any dispensing fee.

             and four lines later asks for `askCents = totalCostCents + dispensingFeeCents`
             (:99, printed at :144) — acquisition cost **plus** a $10.50 fee, the fee treated as
             additional to cost.

SHOULD BE:   A MAC appeal disputes what the plan paid for the *drug* against what the drug cost. The
             dispensing fee is consideration for the professional act of dispensing, not payment for
             the ingredient — which is precisely why this same document's "What is asked" line adds
             a fee on top of acquisition cost rather than netting one off. The shortfall a PBM is
             asked to remedy is `acquisition cost − ingredient reimbursement`. That is also the
             figure the site's own worklist now produces: mac-appeal-candidates.ts:312,
             `c.acquisitionCents - c.paidCents`, where `paidCents` has since this morning been
             `ingredientReceivedCents(...)`.

DIFFERENCE:  Yes, twice over.

             1. The shortfall on the filed document is `cost − ingredient − fee`. It is understated
                by the whole of the dispensing fee the plan paid, on every appeal, every time.
             2. The bold sentence stating the figure is "before any dispensing fee" is not true of
                the figure printed above it. That sentence goes to a PBM under this pharmacy's NPI.

             And since a285cb0 the two halves disagree: the worklist tells the owner a claim is
             `cost − ingredient` below cost, and the PDF generated for that same claim tells the
             plan it is `cost − ingredient − fee`. Two numbers, one appeal.
```

### Ranked

Pre-flight #7 puts this above the money findings. The money is small per claim — the plan's own
dispensing fee, which on a PBM claim is usually a dollar or two, not the $10.50 the letter asks for.
The exposure is the **PBM relationship**: a document filed under the pharmacy's NPI that asserts it
excluded something it included. A reviewer who reconciles the three printed figures against their own
adjudication record finds the fee sitting in a total labelled as excluding it. Appeals are refused
for less, and a pharmacy that files arithmetic a plan can pick apart is a pharmacy whose next appeal
is read differently.

### What it is not

- **Not introduced by `a285cb0`.** `receivedCents = planPaid + copay` predates it. What `a285cb0`
  changed is that the right figure now exists in one shared function, and the letter does not use it.
- **Not live on a page.** Both callers are hand-run scripts (`tsx scripts/mac-appeal-evidence-*.ts`),
  which bounds how many have gone out but not what each one says. It is also my open finding #11 —
  `macAppealWorklist` reaches no page — wearing a different hat.
- **Not the $10.50.** `FEE_CENTS = 1050` (both scripts, :14 and :13) is what the appeal *asks* for
  and is a separate question from what the plan *paid*; I have not checked whether $10.50 is the
  right ask and it is not mine to judge.

## The fix

The right figure already exists and the callers already have every field it needs:

```ts
// mac-appeal-evidence.ts — take the ingredient reimbursement, not the plan's whole remittance
import { ingredientReceivedCents } from "./claim-remedy";
// …
const { cents: ingredient, from } = ingredientReceivedCents(c);
const receivedCents = ingredient;   // null must refuse the document, not print as 0
```

with the claim block carrying `ingredientPaidCents`, `dispensingFeePaidCents`, `remitCents` and
`copayCents` instead of `planPaidCents`, and the printed block becoming:

```
Ingredient reimbursement:  $<ingredient>   (adjudicated | derived from remit + copay − fee)
Acquisition cost:          $<cost>
Reimbursed below cost by $<cost − ingredient>, before any dispensing fee.
```

Two things I would insist on in that block. **`null` must refuse to build the document**, the way
`packForClaim` already refuses a pack size it cannot stand behind (`evidence-one.ts:52`) — a claim
with no reimbursement figure has never been measured and must not be filed as zero. And **the
document should say which of the two it used**, because `claim-remedy.ts:170-171` already makes that
point about screens, and it is truer of a page a PBM reads: a derived figure is one the plan never
sent, and a reviewer is entitled to know the pharmacy worked it out rather than quoted it back.

This is session 1's to make — `mac-appeal-evidence.ts` and both scripts are theirs, and the document
is a compliance artefact rather than a calculation.

## Pre-flight

1. Physical act — the owner running the evidence script and posting or uploading the PDF to a PBM's
   appeal portal. 2. Time — every appeal filed from now, and any already filed. 3. What a pharmacist
   knows that the tables do not — that the dispensing fee is payment for the act, not the drug, and
   that a MAC appeal is about the ingredient line; that is the whole SHOULD BE. 4. Whose money, which
   basis — the plan's obligation to the pharmacy, per claim, no period involved. 5. Units — cents
   throughout; per-unit figures print to four places (`unitMoney`, :85) and that is right, a tablet
   can cost a third of a cent. 6. Same drug — n/a, one NDC per document. 7. **Worst case ranked** —
   PBM relationship over money, as above; no patient or board exposure. 8. Could it pass for the
   wrong reason — yes: `planPaidCents` is a name that reads as "the ingredient the plan paid", and
   the formula is correct for that meaning. It is the two callers that make it remit. 9. When he
   needs to know — before the next appeal is filed. 10. Registers — generated, not mine; HANDOFF
   index updated. 11. **What else reads this figure** — `buildEvidence` has exactly two callers, both
   scripts, both checked above; nothing else imports `mac-appeal-evidence.ts`.
   12. **What I did not check** — how many evidence packs have actually been generated and sent, and
   what the plans' real dispensing fees are on those claims, so I cannot size this in dollars. Both
   need the pharmacy's database. The question is in `HANDOFF.md`.
