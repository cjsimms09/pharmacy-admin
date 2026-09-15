# A remittance date that is wrong is treated worse than one that is missing

**Audited:** `match-remittance.ts`, never audited before, while the base was quiet at `6c95f2b`.
**By:** the cloud session (B). **Method:** the module run.

This module does what it was built for, and the reasoning behind it is right — including the part
most likely to be got wrong:

> *"A payment attached to nothing shows up as unmatched and somebody chases it; a payment attached to
> the wrong claim is invisible, and makes two claims wrong at once… Refusing is the conservative
> direction and the loud one."*

Verified — the two-payer case it exists for is solid:

```
835 names the secondary's BIN                  -> secondary
no BIN, but the amount is the secondary's      -> secondary
no BIN, no amount                              -> NO MATCH (ambiguous: 2)
```

One finding, and it is against the module's own stated purpose rather than against its caution.

---

## The level ladder drops the fill number and the date together

```ts
const levels = [
  (r) => fill matches && date matches && ndc matches,
  (r) => date matches && ndc matches,          // drops the fill number
  (r) => ndc matches,                          // drops the date — and the fill number with it
  () => true,
];
```

Level 1 drops the fill number, for a stated reason: *"A credit memo names the prescription, the drug
and the day it was dispensed but never the fill number."* Level 2 drops the date, for another: *"a
remittance may disagree with the claim about the date by a day — the memo counts the day it was
billed, the claim the day it was filled."*

**There is no level that keeps the fill number and drops the date**, so relaxing the date costs the
fill number too. Run against one prescription with two paid fills — an ordinary refill, same drug,
same payer, same amount:

```
line names FILL 2, date exact            -> fill-2
line names FILL 2, date off by one       -> NO MATCH (ambiguous: 2)
line names FILL 1, date off by one       -> NO MATCH (ambiguous: 2)
line names FILL 2, no date at all        -> fill-2
```

**The last two rows together are the finding.** With **no date**, the matcher uses the fill number
and answers. With a date that is **wrong by one day**, it discards the fill number and refuses. A
wrong date is treated worse than a missing one, and the line said which fill it was paying in both
cases.

**It fails safe** — nothing is credited to the wrong claim, which is the direction this module
argues for and I am not asking anyone to loosen. The cost is the other half of its own sentence:
*"money sitting against nothing is money nobody chases."* That is the reason the looser levels exist
at all, and here they undo themselves.

**The existing test states the intent and only exercises it with one candidate:**

```ts
test("a line whose date is a day out still matches on the drug", () => {
  const r = chooseClaimForRemittance([primary], { ...line, dateFilled: "2026-09-04", … });
  assert.equal(r.claim?.id, "primary");
});
```

With one candidate, dropping to the NDC level finds it and the test passes. With two — which is what
a refill is — the same relaxation loses the discriminator the line supplied. So this is a gap in the
ladder rather than a deliberate choice somebody tested.

**Fix, one line:** a level between the current 1 and 2 that keeps the fill number and drops the date:

```ts
(r) => (line.fillNumber === null || r.fillNumber === line.fillNumber) && (line.ndc11 === null || r.ndc11 === line.ndc11),
```

That is exactly the relaxation the docstring intends, without throwing away a field the remittance
states. The two-payer behaviour is unaffected: on one fill billed twice, both candidates carry the
same fill number, so the new level separates nothing and the BIN and amount discriminators run as
they do today.

**How much it is worth cannot be measured from here** — it needs a count of remittance lines whose
`fillNumber` is present and whose `dateFilled` disagrees with the claim, on prescriptions with more
than one paid fill of the same NDC. That is in HANDOFF. Refills are the commonest thing a pharmacy
does, so the population is unlikely to be nil.

---

## Checked and sound

- **The ladder cannot fall through an ambiguity into a looser level.** Each level is a superset of
  the one before, so once a level returns two or more hits, a looser one can only return more —
  stopping there is right.
- **The BIN is compared on digits** (`digits(r.bin) === digits(line.bin)`), so a BIN printed with
  punctuation or padding still matches. Worth noting because that is where my IPC/IPD finding came
  from elsewhere: here the normalisation is present.
- **`byBin.length > 1` narrows the pool rather than giving up**, so a three-payer fill where two
  share a BIN still gets the amount test against the right two.
- **The refusal sentence names which discriminator was missing** — no BIN, no amount, or several
  paid the same figure — so the person attaching it by hand knows what the site could not tell.

## For 1

1. The fill-number-without-date level. One line, and the two-payer behaviour is untouched.

**Question under "Open items":** how many remittance lines carry a fill number and a date that
disagrees with the claim's, on a prescription with more than one paid fill of that NDC?

Nothing in `match-remittance.ts` or its tests was edited by me.
