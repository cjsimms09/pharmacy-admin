# Four of `FOUNDATIONS.md`'s unchecked items, answered by running `substitutable()`

*12 September 2026 — session 2 (cloud). `src/lib/drug-directory.ts:378`, its consumers, and a
repository-wide search. **One finding, and it is the first thing I have reported that ranks above
money on pre-flight #7.** Three of session 1's open questions answered clean. No file of session 1's
is edited.*

`docs/FOUNDATIONS.md` §"Still to be checked" lists nine things, four of which are settled by reading
and running this one function. Session 1 asked for one of them explicitly: *"The `substitutable()`
function requires a matching TE code, so this may already be right; **it needs proving rather than
assuming**."*

Run, all eight cases:

```
── Narrow therapeutic index ──
Two AB1 levothyroxines, different manufacturers   ->  substitutable = TRUE
Two AB warfarins, different manufacturers         ->  substitutable = TRUE

── Devices with no rating ──
Two metered-dose inhalers, neither rated          ->  substitutable = false
An inhaler rated AB against one unrated           ->  substitutable = false

── Already handled ──
AB1 against AB2, same ingredient                  ->  substitutable = false
AB1 against a bare AB                             ->  substitutable = false
Two B-rated products                              ->  substitutable = false

── Salt forms ──
amlodipine besylate|5 mg|tablet|oral
amlodipine maleate|5 mg|tablet|oral                same key? false   substitutable = false
```

## Confirmed clean — three of the nine, closed

**Inhalers and nasal sprays.** Proved rather than assumed, as asked. A device with no TE code is
refused, and an AB-rated product against an unrated one is refused too, because `isARated` fails on
the null before the group comparison is reached. Session 1's guess was right.

**Salt forms and esters.** Already handled, and deliberately: `equivalenceKey`'s own docstring says
*"Salt forms are not collapsed (amlodipine besylate is not amlodipine maleate here)"*, and the run
confirms the keys differ so `substitutable` is false.

**AB subgroups.** AB1 ≠ AB2 ≠ bare AB, as the docstring claims. Confirmed.

## The finding

```
OBSERVATION  substitutable() returns TRUE for two AB1 levothyroxine sodium 100 µg tablets from
             different manufacturers, and TRUE for two AB warfarin sodium 5 mg tablets. A search of
             src/ and scripts/ for "narrow therapeutic", warfarin, levothyroxine, phenytoin or NTI
             returns nothing outside a hazardous-drugs training module and one invoice comment — no
             narrow-therapeutic-index concept exists in this codebase. Nor does any
             continuity-of-manufacturer guard: "same manufacturer", "stable patient", "mid-therapy"
             appear nowhere.

SHOULD BE    For narrow therapeutic index drugs — warfarin, levothyroxine, phenytoin, lithium,
             digoxin, carbamazepine, theophylline among them — the gap between a therapeutic and a
             toxic concentration is small enough that modest differences in bioavailability between
             products can matter clinically. Standard practice is to keep a patient who is stable on
             one manufacturer's product on that product, and to re-check when a switch is
             unavoidable. An AB rating states therapeutic equivalence for approval purposes; it does
             not answer the different question of whether switching a stable patient is advisable.
             So a tool that recommends changing which NDC to stock should not present an NTI drug in
             the same terms as an ordinary generic.

DIFFERENCE   Yes. Session 1 raised this concern in FOUNDATIONS.md themselves — "a recommendation to
             change NDC on a stable patient is a clinical suggestion the site is not qualified to
             make" — and the run shows nothing in the code acts on it.
```

**How far it reaches, stated precisely rather than dramatically.** `substitutable()` feeds
`withEquivalents` (`drug-file.ts:512`), which is called from `drug-catalog.ts:166` and is live. What
it produces is a **buying** recommendation — put this NDC beside that one, it is cheaper per unit. It
does not tell a pharmacist to switch a patient. But what is bought is what the next refill is
dispensed from, so the clinical consequence is one step removed rather than absent. That is the
honest distance, and it is why this is a flag-and-name problem rather than a refuse-outright one.

**Pre-flight #7, worst case ranked:** patient harm > board > PBM relationship > money. This is the
only thing I have reported today that reaches the first rank; everything else has been money. It
should be read in that order.

**What a fix is not.** It is not for me to choose the list. Which molecules the pharmacy treats as
narrow therapeutic index is a clinical judgement — the FDA has never published a single definitive
list, states differ, and some boards publish their own. What the code can carry is the *shape*: a
flag on the row, and a sentence saying a stable patient should not be switched on price alone. The
list itself is the pharmacist-in-charge's, and it belongs in a register beside the other decided
things rather than hardcoded by me.

## For session 1

One question, and it is clinical rather than technical: **which molecules does he want treated as
narrow therapeutic index, and should the buy list flag them, rank them lower, or leave them out of
the equivalents comparison entirely?** Three different answers, all defensible, and it is his call,
not mine and not yours.

The other five items on the unchecked list — partial and completion fills, DIR fees landing
retroactively, credits reducing cost in the month they land, compounds, 340B — need the database and
are session 1's side.
