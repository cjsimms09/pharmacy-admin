# One deposit, two roads, and a key that normalises one half of itself

15 September 2026 · helper B (cloud) · rule 6 reading of `284547b..7b9ae83`, seventeen commits.

`npm run check` clean on the merge: **3,378 tests, 749 suites**, build compiled.

---

## Resolved by session 1: my open row 24

`911fe37` withdraws the fill-date rule. `isOutOfBooks` is back to one form
(`books-start.ts:63-66`, one argument) and both call sites in `claim-payments.ts` pass only
`receivedOn`, so `ar-report.ts:163`'s second statement of the rule states the same rule again and its
docstring — *"a rule worth stating twice is this one"* — is true. **Row 24 closed.**

Worth recording plainly: session 1 found a second unfound reader of the same flag and it cost real
money — `profit-and-loss.ts` reads `out_of_books` for the *cash* account, so the rule removed
$2,789.08 of September cash. Their own summary of the shape is the same one my row 24 named:
*"a flag's meaning was changed without finding every reader of the flag."* I found one reader, they
found the expensive one. The finding was right and incomplete.

## Read and clean

- **`7d65bd5`** — freight on an invoice total reported as goods billed and never received. The
  separation it introduces, lines-over-receipt versus total-over-lines, is the right cut: a charge is
  not goods.
- **`5782643`** — the eight o'clock pull running at seven the night before.
- **`ae85f5b` / `3ed700d`** — the sign-in page not counting as use. Both are about the site's own
  measurement rather than the pharmacy's money.
- **The banking design itself is right, and I want that first.** One function, `bankPayerPayments`
  (`payer-payments-store.ts`), is the only place a payer payment becomes a cash receipt, for both the
  portal's report and the new EFT notice — *"a second copy of it beside the notice reader would
  drift, and the first drift would be revenue the pharmacy did not earn."* A second arrival under a
  known key with a **different amount** is named as a disagreement and never overwritten, which is
  rule 5 kept where it costs something.

## The finding

```
OBSERVATION: Two documents now bank the same deposit and are kept apart by one shared source key
             (payer-payments-store.ts:35):

                 const key = (p) => `payer-payment|${p.payerName.trim().toLowerCase()}|${p.paymentNumber.trim()}`;

             The payer is case-folded. **The payment number is not** — only trimmed.

             The two producers disagree about case by construction:

                 health-mart-eft.ts:110    paymentNumber: eft.toUpperCase()
                 payer-payments.ts:126     paymentNumber: (get("paymentnumber") ?? "").trim()

             The notice reader forces upper case; the portal reader passes through whatever the
             report prints. So `EFT-1234ABCD` and `eft-1234abcd` are two different keys for one
             deposit, and the gate that exists to stop one deposit being banked twice does not fire.

             Session 1's own notice on this change puts the exposure at 20 third-party receipts,
             $250,562.16, in September.

SHOULD BE:   An identity used as a duplicate guard must be normalised the same way for every producer
             that can mint it. That is not a general preference here — it is the reason the payer
             half *is* folded: two documents may spell one payer differently. The payment number is
             the half more likely to vary in case, because one of the two producers changes its case
             deliberately. A guard that holds only while two separately-authored readers agree about
             letter case is not a guard; it is a coincidence that has not broken yet.

             The module says so itself: *"Two sources for one deposit … share one key so they cannot
             bank it twice."* "Cannot" is the claim being made, and half a normalisation does not
             support it.

DIFFERENCE:  Yes. The key is half-normalised, in the half where the two producers are known to
             differ. Whether it is *currently* banking anything twice depends on how the portal's
             report prints the EFT number, which I cannot see from here — so I am not claiming money
             has moved. I am claiming the guard does not do what its own docstring says it does.
```

Ranked **money**. Not live-proven, and I have not placed it above the findings that are.

### The fix, and the trap in it

One line — fold the payment number the same way:

```ts
const key = (p: PayerPayment) =>
  `payer-payment|${p.payerName.trim().toLowerCase()}|${p.paymentNumber.trim().toUpperCase()}`;
```

**But not on its own.** `source_key` is already stored on live `cash_receipts` rows. Change the
function and every row banked under a mixed-case key stops matching its own key, so the very next
import of that report banks those deposits a second time — the fault being fixed, caused by the fix,
on the day of the fix. It needs a migration that rewrites existing `source_key` values by the same
rule, in the same commit. Additive and numbered, and `0120` is now taken.

## The question I cannot answer from here

Does the portal's payer payment report print `payername` as something that lower-cases to exactly
`health mart atlas` (the constant at `health-mart-eft.ts:50` is `"Health Mart Atlas"`)? If it prints
the individual third party instead — Caremark, OptumRx — or any other wording, the two keys differ
**whatever** the case handling, and the shared-key guarantee does not exist at all for these rows.
That needs one real report and belongs to the pharmacy computer. It is in `HANDOFF.md`.

## Pre-flight

1. Physical act — the owner importing the weekly payer payment report after the daily EFT notices
   have already landed by email. 2. Time — now, and every week both feeds run. 3. Pharmacist's
   knowledge — n/a; this is an accounting-identity question. 4. **Whose money, which basis, already
   counted elsewhere** — his, cash basis, and "already counted elsewhere" is the whole finding: a
   double bank inflates cash revenue against nothing. 5. Units — cents and an opaque payment
   identifier; no unit risk. 6. n/a. 7. **Worst case ranked** — money; no patient, board or PBM
   exposure. 8. **Could the check pass for the wrong reason** — yes, and that is the point: it passes
   today if and only if the portal happens to print upper case, and nothing tests or records that.
   9. When he needs to know — before the next payer payment report is imported. 10. Registers —
   `docs/registers/` generated, not mine; HANDOFF index updated and row 24 closed.
   11. **What else reads this figure** — `key` has one definition and is used for both the held-row
   lookup and the write, so the two sides of the gate agree with each other; the risk is entirely
   between producers, not between reader and writer. `gateDeposit`/`matchHeldDeposit` in
   `deposit-gate.ts` is a separate guard on the bank-statement road and is not affected.
   12. **What I did not check** — the real report's `payername` and payment-number casing (above),
   and whether any `cash_receipts.source_key` already on file is mixed case, which would decide
   whether the migration above has anything to rewrite. Both need the pharmacy's database.
