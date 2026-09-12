# Splitting a bundled 835 is right, and the deposit gate now refuses every set after the first

**Audited:** `4615a7c`…`1a8554f` (three commits) against `feature/compliance`. **By:** the cloud
session (B). **Method:** the readers and the gate run.

`1a8554f` fixes a real and serious fault, and the diagnosis is exactly right: an X12 file is an
envelope around one or more ST/SE sets, each 835 set is a whole remittance with its own payer, trace
and BPR02, and reading a file as one remittance made a bundle come out as the last payer with
everybody's claims merged into it. Verified — a two-payer file now splits cleanly and each half
balances against its own total:

```
payer=EXPRESS SCRIPTS  trace=111  BPR02=6000  claims=1  balance diff=0
payer=CAREMARK         trace=222  BPR02=4000  claims=1  balance diff=0
```

The splitter is sound: only ISA and GS are kept as the envelope, sets are bracketed ST..SE, an
unterminated trailing set is still emitted, and no segment can belong to two sets — so no claim can
be counted twice.

**And that is what makes the finding below urgent rather than theoretical.** Each set is now banked
separately, and the deposit gate has never been asked to look at siblings from one file before.

---

## 1. Every set of a bundle sharing one EFT trace is refused after the first

`importOneRemittance` banks each set with `reference: r.traceNumber` and
`sourceKey: 835|payer|trace|paidOn`. `gateDeposit` refuses on **either**:

```ts
const same = held.find((h) => h.sourceKey === incoming.sourceKey);      // :96  identity
...
const byReference = held.find((h) => digits(h.reference) === mine);     // :105 the trace's digits
```

Run, using `682062c`'s own example — EFT-31399961, which it reports as holding Caremark, OptumRx and
Maxor Plus together:

```
Caremark     $  5000.00  ->  BANKED
OptumRx      $  4000.00  ->  REFUSED: EFT-31399961 is already banked as 5000.00 on 2026-09-01, though this copy says 4000.00
Maxor Plus   $  4726.21  ->  REFUSED: EFT-31399961 is already banked as 5000.00 on 2026-09-01, though this copy says 4726.21
banked total: $5000.00 of $13,726.21
```

and with no trace at all, where the key falls back to the file name:

```
$   60.00  ->  BANKED
$   40.00  ->  REFUSED: already banked from the 835 reader on 2026-09
banked total: $60.00 of $100.00
```

**The claim side posts all of it and the cash side banks one set**, because each set's claim payments
carry their own prescription numbers and clear their own dedupe. So the two halves disagree by
exactly the unbanked amount — money the site believes it earned and never saw arrive.

**And the failure changed shape rather than going away.** Before `1a8554f` a bundle failed its own
balance check and posted **nothing**, loudly, with a problem naming the difference. Now it posts the
first set and refuses the rest into `refused[]`, which is not an error and is not on the page the
owner reads. A visible total failure has become a silent partial one.

**The one thing I cannot establish from here, and it decides the size of this:** whether the sets
inside a real ProviderPay bundle carry the *same* TRN02 or one each. TRN is mandatory in 5010, so
the no-trace case above needs a malformed file and is narrow. The shared-trace case is not narrow at
all — it is plausible precisely because TRN02 is the EFT reference and ProviderPay sent one EFT — and
`682062c` says 32 of 62 traces hold more than one PBM. **That question is for 1** and it is one
command against a September file: for each ST in a bundle, print TRN02.

**Fix, whichever the answer:** make the deposit's identity the *set*, not the file — append the set's
index or its own BPR02 to both `sourceKey` and the fallback reference, so three remittances under one
EFT are three deposits that together equal the EFT. The reference-digits rule at `deposit-gate.ts:105`
is the open finding I raised on 11 September; this is not a re-report but a new way for it to bite,
and it now fires on a payer's *own* correctly-read file rather than on a coincidence between payers.

---

## 2. A non-835 transaction set becomes a phantom remittance

`parse835Sets` splits on ST..SE and never checks ST01. A file holding an 835 and a functional
acknowledgement:

```
sets returned: 2
payer=EXPRESS SCRIPTS  trace=111  BPR02=6000  claims=1  balance diff=0
payer=null             trace=null BPR02=null  claims=0  balance=null
```

Harmless to the money as it stands — with no payments it cannot bank, and with no BPR02 the balance
check cannot fire either. Two costs, both small: the file takes the aggregating branch when it holds
one remittance, and `remittances: 2` is reported to the owner for a file with one. The site already
has the test — `isX12Remittance` requires `ST*835` — so the guard is one condition in the loop.

---

## Checked, and worth saying

- **The splitter cannot double-count.** Each segment joins at most one open set, and the envelope
  kept is ISA/GS only.
- **`682062c`'s reasoning is superseded by `1a8554f` and both fixes stand.** The earlier commit
  concluded a ProviderPay remittance "genuinely has no single payer to name" from the 32-of-62
  multi-PBM traces; the later one reinterprets those as merged bundles. Attributing a payment through
  the claim's BIN is right either way, and it is the rule `payer-owed-store.ts` already applied, so
  the two halves of the payer picture agree. No finding.
- **This shrinks the population hitting the refused-remittance delete.** Bundles used to fail the
  balance check, and the folder sweep deletes a file it counted as read — so bundles were being
  deleted after posting nothing. Fewer files will hit that now. The delete itself
  (`docs/audits/2026-09-11-refused-remittances-are-deleted.md`) is unchanged and still open.
- **The ProviderPay folder route does not bank at all**, so the arithmetic above bites on the Add
  tool and the mailbox, which pass `bank: true`. That is the `remits/page.tsx:159` finding from
  11 September, still open, and it means the promoted download route would not show this yet.

## For 1

1. Give each set its own deposit identity — `sourceKey` and reference — so a bundle banks in full.
   Finding 1.
2. `ST01 === "835"` in the split loop. Finding 2.

**Question under "Open items":** in a real September ProviderPay bundle, do the ST sets carry one
shared TRN02 or one each?

Nothing in `x12-835.ts`, `claim-payments.ts`, `deposit-gate.ts`, `plan-evidence.ts` or `plans.ts` was
edited by me.
