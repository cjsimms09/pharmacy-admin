# "About five per cent" is two numbers, and only one of them is his to change

15 September 2026 · helper B (cloud) · rule 6 reading of `882307e..19e3dd4`, twelve commits.
`npm run check` clean on the merge: **3,434 tests, 765 suites**.

---

## The finding

```
OBSERVATION: `54bee8c` rewrites the sentence the owner reads where the account says a cost is not in
             it (`profit-and-loss.ts:577-579`, the `missing` list):

                 "Card processing fees — about five per cent of card takings in August. Global
                  Payments' monthly statement books them when it is forwarded to the inbox; typing
                  them on Spending as well counts them twice."

             It replaces "two to three per cent of everything taken on a card" — a general claim —
             with a measured one, which is the right direction.

             The statement it was measured from already separates the two halves of that five per
             cent, and has since `5cdff17` (`card-statement.ts:47-54`):

                 passThroughCents   "The card networks' interchange and assessments, passed through
                                     at cost."
                 processorCents     "Global Payments' own charges."

             computed at `:125-126`. The sentence uses neither; it reports only the total.

SHOULD BE:   This sentence sits on a list of costs the account is missing, so its job is to size the
             hole *and* say what to do about it. It does the second well. For the first, the two
             halves of a card fee are different kinds of money and lead to different actions:
             interchange and assessments are set by the card networks and passed through at cost —
             the pharmacy cannot negotiate them, and the only lever is the mix of cards taken
             (steering to PIN debit, a cash price). The processor's own charges are a contract, and
             that contract is negotiable.

             Five per cent all-in is roughly double what a pharmacy of this shape usually pays, so
             this is a number that ought to make him do something — and which of the two things
             depends entirely on a split the site has already read off the statement.

DIFFERENCE:  Yes. The figure is right and the sentence is what is wrong: it collapses the only
             distinction that tells him whether to ring Global Payments or change how he takes
             payment. Rule 6's own test — *"ask what the number would make him do, not whether it is
             right"* — has two answers here and the sentence supports neither.
```

Ranked **money**, and small: it changes no figure on any account. What it changes is whether a man
reading that line knows which of two doors to walk through.

### The fix

The fields exist, so the sentence can carry them:

> *"Card processing fees — about five per cent of card takings in August: X% the card networks'
> interchange, passed through at cost, and Y% Global Payments' own charges. Only the second is a
> contract. Their monthly statement books both when it is forwarded to the inbox; typing them on
> Spending as well counts them twice."*

Session 1's, in `profit-and-loss.ts`.

## Not a finding, but worth one line: the diff on the money engine

`profit-and-loss.ts` shows **1,258 insertions and 1,258 deletions** across `882307e..19e3dd4`.
`git diff -w` shows **one line changed** — the sentence above. The file was stored with CRLF at
`882307e` (1,258 carriage returns) and with LF at `19e3dd4`.

The cost is already paid and does not recur: **no tracked file in the repository carries CRLF at
HEAD any more** — I counted, across `*.ts`, `*.tsx`, `*.json`, `*.md` and `*.yml`, and it is zero.
So this is a one-off normalisation, not a pattern, and it is not a finding.

The only residual is that nothing prevents it happening again: `.gitattributes` exists and covers
`*.sh` only, for exactly this reason ("CRLF breaks them there"). One more line — `* text=auto` or
`*.ts text eol=lf` — would keep it from ever burying a real change in the money engine again. Worth
doing whenever `.gitattributes` is next open; not worth a commit of its own.

## Also read and clean

`d477ee4` (835s and MTF deposits never bank beside the door that already counts them), `7b71c14`,
`4c61e77` (McKesson's rebate arriving as three HEW LLC credits, recognised and never banked by hand),
`0b61a0f`, `54bee8c`'s own behaviour change (card fees booked unpaid and dated by the bank's debit),
and the new scanned-statement reader, which is **deliberately not wired** in `7f89689` and then wired
in `19e3dd4` with what the balances cannot prove left for a person. Every one of them is another door
closed on the same dollar, which is the right shape.

## Pre-flight

1. Physical act — the owner reading the missing-costs list and deciding whether to do something about
   card fees. 2. Time — now, and until the fees are in the account. 3. Pharmacist's knowledge — what
   a pharmacy of this size normally pays to take a card, and that interchange is not negotiable while
   a processor contract is; that is the SHOULD BE. 4. Whose money, which basis — his; the sentence
   sits on both bases' missing list and changes no figure. 5. Units — per cent of card takings for
   one named month, and the month is named, which is right. 6. n/a. 7. **Worst case ranked** — money,
   and indirect: it costs a decision, not a figure. Below everything on the index that moves a
   number. 8. Could it pass for the wrong reason — yes: the arithmetic is right, the month is named,
   and nothing about it looks wrong, which is the class rule 6 was written for. 9. When he needs to
   know — whenever he next looks at what the account is missing. 10. Registers — HANDOFF updated.
   11. What else reads this figure — the sentence is a string in the `missing` list; no calculation
   depends on it. 12. **What I did not check** — the actual split. I do not have the statement, so I
   cannot say whether the five per cent is mostly interchange or mostly Global Payments, and
   therefore cannot say which door he should walk through. That is the whole point of asking for the
   split rather than asserting an answer, and the numbers are on the pharmacy computer.
