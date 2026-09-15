# The register's state column has one state, because the ternary that chooses it returns the same word twice

*12 September 2026 — session 2 (cloud). `scripts/registers.ts:115` and
`docs/registers/claim-fields.md`, both new in `e67a0ca`. **No file of session 1's is edited.***

```
OBSERVATION  scripts/registers.ts:115 reads

               const state: State = filled === 0 ? "never-measured"
                                  : filled === total ? "captured" : "captured";

             The second conditional returns the same value on both arms. So in
             docs/registers/claim-fields.md every populated field prints "captured", whatever its
             coverage: rx_number at 2,546 of 2,546, evoucher_cents at 2,314, dir_fee_cents at 5,
             awp_cents at 6, contract_id at 3, daw at 5. One word over a range from 0.1% to 100%.

             The zero branch is discarded too: it computes "never-measured", and line 117 then
             prints the literal "**never populated**" instead, so the State value is never used on
             that path either.

SHOULD BE    CLAUDE.md §5: "Four states, never one word. Captured · expected-not-yet ·
             never-measured · measured-and-none · not-captured. 'Missing' is not a state and must
             never be reported as one." The register's own header says the same in its own words:
             "A field the feed never fills is a fact the site cannot use — and one it fills but
             nothing reads is a fact being thrown away." A field on 0.1% of rows is not in the same
             state as one on all of them, and the state column exists to say which.

DIFFERENCE   Yes, and it is a one-line defect rather than a design question: a conditional whose
             two arms are identical cannot have been the intent.
```

## Why it matters more than a cosmetic slip

The point of the state column is to separate two facts that look alike, and the two it currently
cannot separate are exactly the ones that matter:

- **`daw` at 5 of 2,546 is correct and expected.** A DAW code is only set where a prescriber has
  given a substitution instruction; most claims legitimately carry none. "Captured" is arguably the
  right word.
- **`dir_fee_cents` at 5 of 2,546 is a different fact entirely.** DIR fees are assessed per claim and
  land months later, so five today is the signature of *expected, not yet arrived*.
- **`contract_id` at 3 of 2,546 is a third fact** — a claim gets one only where a contract priced it,
  which is a coverage figure the pharmacy would want to watch.

Three different truths, one word. And it is the register the constitution leans on hardest:
*"a register kept by hand rots, and a rotted register is worse than none — it reads as authoritative
and is out of date."* A generated register that flattens its own state column has the same defect
with better credentials.

**Stated fairly:** the counts are still printed beside the word, so a reader who looks at the numbers
can see 5 against 2,546. Nothing is hidden. What is lost is the column that was supposed to mean the
reader does not have to.

## The mechanism to fix it already exists, one register up

`DECIDED` (`registers.ts:39`) carries exactly the judgement measurement cannot supply, keyed by
register and line, and the expenses register consults it at `:90`. It already holds the right answer
for this very field on the other side of the books:

```ts
"expense:DIR fees and price concessions": { state: "not-captured", note: "arrives months later, retroactively per claim, entered by hand" },
```

It is never consulted for claim fields. A `claim-field:dir_fee_cents` key would say
*expected, not yet arrived* in the same sentence the expenses register already says it in.

**What the partial state should be called is session 1's to choose**, and it is a real choice: a
sixth word, or `DECIDED` entries for the handful of fields where sparse means something, or both. I
am not picking it, because which fields are legitimately sparse is a judgement about this pharmacy's
dispensing rather than about the code.

## Checked and found sound, so nobody re-derives it

Two things I suspected and proved wrong before writing, recorded because the constitution asks for
that:

1. **I thought `dir_fee_cents` was captured by the pull and ignored by the accounting.** It is read by
   no accounting module — true — but `profit-and-loss.ts:582-587` already pushes the right sentence
   to `missing`: *"DIR fees and price concessions for the month. These are entered by hand, so an
   empty line means nobody has entered them rather than that there were none."* The FOUNDATIONS item
   is already answered on the screen. No finding.
2. **I thought `claim-fields.md` was missing thirteen of the fifty-one columns.** It lists all 51 (and
   one, `sold_checked_on`, that is no longer a column on `claims`). My first reading was a truncated
   `head`. No finding.
