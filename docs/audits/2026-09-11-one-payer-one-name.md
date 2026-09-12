# "One payer, one name" reached one of the two functions that group payers

**Audited:** `89dc97d`…`e49dd23` (five commits) against `feature/compliance`. **By:** the cloud
session (B). **Method:** the code, run.

`89dc97d` is a good fix for a real fault: August's remittances arrived as both
`EXPRESS SCRIPTS INC` and `EXPRESS SCRIPTS INC.`, and `payerKey` lower-cased but kept the full stop,
so one payer was two — $37,438.32 and $3,867.12, *"and the smaller looks like a minor payer nobody
need think about."* `normalisePayerName` is deliberately timid in exactly the right way: it refuses
to drop corporate suffixes, on the grounds that a wrongly merged payer is harder to notice than a
wrongly split one because no total ever disagrees. That reasoning is correct and worth keeping.

Two findings, and the first is the fix not being finished.

---

## 1. There are two `payerKey` functions, and only one of them was fixed

`payer-owed.ts:149` — the one the commit fixed — now normalises, and prefers the BIN:

```ts
export function payerKey(bin: string | null, name: string | null): string {
  const b = (bin ?? "").trim();
  if (b) return `bin:${b}`;
  const n = normalisePayerName(name);
  return `name:${n || "unnamed"}`;
}
```

`payer-map.ts:127` is a second function of the same name, local to that file, untouched, and with the
**opposite precedence** — the raw printed name first, the BIN only as a fallback:

```ts
const payerKey = (f: Fill): { key: string; bin: string | null } => {
  const p = f.payers[0];
  return { key: p.name ?? p.bin ?? "unnamed", bin: p.bin };
};
```

Not lower-cased, not normalised. Run against the very rows the commit is about:

| name | bin | `payer-owed` key | `payer-map` key |
| --- | --- | --- | --- |
| `EXPRESS SCRIPTS INC` | 003858 | `bin:003858` | `"EXPRESS SCRIPTS INC"` |
| `EXPRESS SCRIPTS INC.` | 003858 | `bin:003858` | `"EXPRESS SCRIPTS INC."` |
| `EXPRESS SCRIPTS INC` | — | `name:EXPRESS SCRIPTS INC` | `"EXPRESS SCRIPTS INC"` |
| `EXPRESS SCRIPTS INC.` | — | `name:EXPRESS SCRIPTS INC` | `"EXPRESS SCRIPTS INC."` |

The Payer map splits Express Scripts in **both** cases — including the one where a BIN exists that
would have united them, because its key puts the name first and never reaches the BIN.

**And this one ranks.** That key is what `scoreBy` accumulates on (`payer-map.ts:268-280`): `fills`,
`revenueCents`, and ultimately `spreadPerFillCents`, whose own comment calls it *"the size of the
prize for steering or appealing."* A payer under two spellings becomes two rows with its volume and
its margin halved between them, and each ranks lower than the real payer would. That is the commit's
own sentence — the smaller looks like a minor payer nobody need think about — still true on the page
built to say which payers are worth steering to.

The name arrives raw: `fills.ts` sets `name: p.name ?? null` (`:335`) and `name: r.pbmName ??
r.payerLabel` (`:372`), and imports nothing from `payer-name.ts`. So there is no normalisation
upstream either.

**Fix:** give `payer-map.ts` the shared rule. Either call `payerKey` from `payer-owed.ts`, or at
minimum `normalisePayerName(p.name)` with the BIN preferred where there is one, so the two functions
answer "which rows are one payer" the same way. `ar-report.ts:215` already states the principle —
*"Grouped with `payerKey` rather than with a rule of this file's own"* — and it is the right one.
`nameOf` (`:124`) joins raw names for display and would follow from the same change.

---

## 2. The `&` rule's stated justification does not hold for its own example

The rule is right and the comment is wrong about why:

> *"'SS&C HEALTH' and 'SS C HEALTH' would otherwise differ only by a space that stripping had
> introduced, which is the same bug in the other direction."*

Run:

| a | b | same payer? | normalised |
| --- | --- | --- | --- |
| `SS&C HEALTH` | `SS C HEALTH` | **different** | `SS AND C HEALTH` / `SS C HEALTH` |
| `JOHNSON & JOHNSON` | `JOHNSON AND JOHNSON` | same | `JOHNSON AND JOHNSON` |
| `A&B HEALTH` | `A AND B HEALTH` | same | `A AND B HEALTH` |

Replacing `&` with `AND` does not make the cited pair agree; it changes the difference from a space
to a word. What the rule genuinely buys is the second and third rows — a name written `&` matching
the same name written `AND` — which is real and worth having.

No money moves on this. It is here because of the maxim this repository applies to itself, and which
I have already reported once against the counted-once register: *"A page that describes a method the
code does not use is worse than one that says nothing."* The next person to touch this will reason
from that sentence. Replace the example with one the rule actually handles.

---

## Checked and cleared

- **`providerpay-account.ts` banks nothing.** It exports `payerFrom`, `looksLikeAccountHistory`,
  `readAccountHistory` and `whatMadeUpTransfer`, and calls neither `addCashReceipt` nor
  `gateDeposit`. It resolves a bank statement's lump back into payment numbers and payers, which is
  explanation rather than money — exactly what `docs/MONEY-TRACE.md` says it should be: *"Count a
  dollar at exactly one point in its chain: where it reaches the operating account. Everything
  upstream is explanation, not money."* I went looking for a third feed banking the same deposit and
  there is not one.
- **The timidity of `normalisePayerName` is correct**, and I am not proposing suffix-stripping. Two
  real companies merged is the worse failure and the docstring says so.
- **A fresh database migrates clean** on the merged tree, with `0118` and `0119` in the journal.

## For 1

1. One rule for "which rows are one payer": `payer-map.ts:127` to use the shared `payerKey`, or at
   least `normalisePayerName` with the BIN preferred. Finding 1.
2. An example in `payer-name.ts` that the rule actually handles. Finding 2.

Nothing in `payer-name.ts`, `payer-owed.ts`, `payer-map.ts`, `fills.ts` or `providerpay-account.ts`
was edited by me.
