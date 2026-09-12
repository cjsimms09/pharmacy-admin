# A remittance the site refuses is deleted from the folder, and two more

**Audited:** `f366cac`…`4d78994` (eight commits) against `feature/compliance`. **By:** the cloud
session (B). **Method:** the code, run. Every table and quoted figure below is output.

First, the gate: **a fresh database migrates clean on the merged tree**, and the journal is
consistent — `0115` never existed and is referenced nowhere, so the gap in the filenames is a gap
and not a missing migration.

Three findings. The first is data loss and it is live.

---

## 1. A remittance refused by the balance gate is deleted from the watched folder

`ab13a56` deletes a remittance once it has been read, for two good reasons — ProviderPay keeps the
original, and an 835 names patients, so a copy in a synced folder is PHI kept for nothing. The
safety claim is explicit:

> *"Only files that were actually read reach here. A remittance that failed to parse, or one refused
> as unreadable X12, is left exactly where it is — **deleting a file nobody has successfully read
> would destroy the only copy of something still needing attention**."*

That holds for a file that throws. It does not hold for the one case the site deliberately refuses.

`importRemittance` **returns normally** when the payer's own arithmetic does not balance
(`claim-payments.ts:395-400`):

```ts
if (r.balance && r.balance.differenceCents !== 0) {
  out.problems.push(`The remittance does not balance: … Nothing from it was stored.`);
  return out;
}
```

Its own comment three lines up says this *"leaves the file to be looked at."* The sweep then does
this (`claim-payments.ts:646-653`):

```ts
const r = await importRemittance(text, c.name, user);
out.read++;
…
out.problems.push(...r.problems);
markDone(c);          // unconditional — no check of r.problems, r.payments or r.amountCents
```

and every marked file is unlinked at `:758`. So a remittance that **stored nothing**, counted as
`read`, is deleted. The file the site refused because it could not trust its arithmetic is the one
file it destroys, and it is exactly *"something still needing attention."*

**The stated recovery is weaker than it looks.** *"ProviderPay holds every remittance and will hand
it back"* — and `d76db3b`, pushed in this same set, is titled *"Write down the download bug that
lost three remittances."* Re-downloading is the fallback, and the fallback has a known fault that
loses files.

**Fix:** mark done only where something was actually taken — `if (r.problems.length === 0)`, or on
`r.payments > 0`. A refused file left in the folder is untidy; the import already refuses a
remittance it has taken, so re-sweeping it is harmless. That is the trade the commit itself makes
for a failed delete, and it should be made here too.

---

## 2. One readable entry in an archive deletes the whole archive

`markDone` records `c.onDisk`, which for every entry of a zip is the **outer archive**:

```ts
candidates.push({ name: `${entry} → …`, dir, onDisk: entry, buf: e.data });   // :617
```

and the loop's catch records a problem without un-marking anything (`:724-726`). So an archive
holding one 835 that reads and one that throws is marked done by the first, and unlinked with the
second still unread. Nothing in the folder, nothing in the database, one line in `problems`.

The same block also decides an archive by magic bytes — `buf.subarray(0, 2) === "PK"` — so an
`.xlsx` or `.docx` dropped in the watched folder is taken apart into its OOXML parts, each filed as
a document, and the workbook then deleted. That is the finding I reported against `cfdbd08`
(`docs/audits/2026-09-11-remits-one-upload.md` finding 2), now in a second place and with a delete
behind it. And the archive is still opened with the unbounded `readZip`.

**Fix:** mark an archive done only when every entry it produced was dealt with.

---

## 3. A negative CAS amount makes the reconciler produce figures that cannot be true

`claim-reconcile.ts` is careful and its reasoning is right — it records the bug its own tests
caught, and it is correct that a contractual write-off is already inside what PioneerRx expected.
One case is unguarded. `explainedCents` has no floor:

```ts
const explainedCents = Math.min(shortfallCents, payerInitiatedCents + otherCents + copayGap);
const unexplainedCents = shortfallCents - explainedCents;
…
revenueAdjustmentCents: explainedCents,
```

A CAS amount may be negative — a payer reversing an earlier reduction — and the parser passes it
through. Confirmed against the real parser:

```
parsed from CAS*PI*45*-15.00 : [{"groupCode":"PI","reasonCode":"45","amountCents":-1500, …}]
```

Run through `reconcileClaim` with $60 expected and $45 paid:

| adjustments | state | shortfall | explained | unexplained | revenue adj |
| --- | --- | ---: | ---: | ---: | ---: |
| `PI 1500` | short_explained | 1500 | 1500 | 0 | 1500 |
| **`PI -1500`** | unexplained | 1500 | **−1500** | **3000** | **−1500** |
| **`PI 500`, `OA -1500`** | unexplained | 1500 | **−1000** | **2500** | **−1000** |

Three things that cannot be true at once: **more unexplained than the whole gap** (3000 against a
1500 shortfall), a negative quantity of explanation, and a **revenue adjustment that adds $15 to a
claim which came up $15 short** — the field whose own docstring says it is "how much this reduces
accrued revenue."

**Caught before it is wired.** `reconcileClaim` and `reconcileFill` have no caller anywhere in
`src` yet, so no figure has moved. That is the reason to fix it now rather than the reason not to.

**Fix:** `Math.max(0, …)` inside the `Math.min`, and a test for a negative CAS — there is none
today (`grep 'amountCents: -' tests/claim-reconcile.test.ts` returns nothing).

---

## Checked and cleared, so nobody re-checks them

Two things I went after in this module and did **not** report, because the code is right:

- **An unrecognised group code explaining a shortfall is deliberate**, not a slip: there is a test
  named *"an unknown group is kept as printed and can explain a shortfall"*. The payer named an
  amount and a reason; the site not knowing its group does not make the money unaccounted for. I
  had this drafted as a finding and dropped it.
- **A missing CAS01 cannot reach that bucket at all.** `x12-835.ts:190` — `if (!groupCode) return []`
  — so "the reader produced no group" never becomes "the payer explained it". Confirmed by running
  the parser.

And one that is now right in one place and wrong in another: the folder sweep builds its document
from the **entry's** bytes —

```ts
const asFile = new File([new Uint8Array(c.buf)], c.name.split(" → ").pop() ?? c.name);   // :702
```

— which is exactly the fix I proposed for the Remits page upload, where `storeFile(part.file)` still
stores the outer archive for every entry (`2026-09-11-remits-one-upload.md` finding 3). The correct
pattern now exists four hundred lines from the wrong one. Both inserts still write `documents` with
no `sha256` check, against the rule at `invoices.ts:988`.

## For 1, ordered

1. `markDone` only where something was stored. Finding 1 — it is destroying files now.
2. Mark an archive done only when every entry was dealt with. Finding 2.
3. `Math.max(0, …)` and a negative-CAS test. Finding 3, before it is wired.

Nothing in `claim-payments.ts`, `claim-reconcile.ts` or `x12-835.ts` was edited by me.
