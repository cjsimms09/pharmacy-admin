# 459 plans adopted: the safety claim holds, checked rather than taken

*12 September 2026 — session 2 (cloud). Audit of `1a53e39`, "Classify 459 plans, and keep a register
of what is still open". **Nothing to fix.** Recorded so the checking is not repeated.*

`1a53e39` adopted 459 plan classifications covering 1,588 claims and $206,059.80 of reimbursement,
and rests on one load-bearing claim:

> *"`PROPOSABLE` excludes the four classes that decide whether the Kansas floor reaches a plan, every
> class that can be offered is out of that floor's reach, and `needsBasis` is false for all of them —
> so **the worst a wrong adoption does is leave money out of a filing, never put it in one wrongly**."*

$206,059.80 is too much to take on the sentence, so it was checked against the code.

## The classes that can be proposed

```ts
PROPOSABLE = ["medicare", "medicaid", "workers_comp", "discount_card", "copay_card",
              "commercial_unknown_funding"]                        // plan-evidence.ts:712
```

Against `planScopeOf` (`plans.ts:103-118`), which is what decides SB 20 reach — only
`commercial_fully_insured`, `governmental` and `church_plan` return `commercial_non_erisa`:

| proposable class | `planScopeOf` | in the Kansas floor's reach |
|---|---|---|
| medicare | `part_d` | no |
| medicaid | `medicaid` | no |
| workers_comp | `unknown` (default) | no |
| discount_card | `unknown` | no |
| copay_card | `unknown` | no |
| commercial_unknown_funding | `unknown` | no |

`commercial_unknown_funding` — 372 of the 459 plans, $103,654.78 — falls to the `default` arm and
returns `"unknown"`, so it does not reach `commercial_non_erisa`. That is the one that had to be
right, and it is. `CLASS_INFO` agrees independently: `medicaid: { inScope: false }`,
`workers_comp: false`, `discount_card: false`.

The two consumers that act on scope both read it the same way and both exclude these:

```ts
if (planScopeOf(cls) === "commercial_non_erisa" && c.dateFilled >= SB20_EFFECTIVE_FROM) return "floor";
                                                          // drug-profit-store.ts:74
const byLaw = cls === "medicaid" || (planScopeOf(cls) === "commercial_non_erisa" && …);
                                                          // over-nadac-store.ts:58
```

`copay_card` and `discount_card` go further in the safe direction: `against-nadac.ts:158-165` gives
them standing `"the price"` rather than `"owed"`, so a wrong adoption there takes a claim *out* of
what is owed, never into it.

## The one place a proposable class adds rather than subtracts

`over-nadac-store.ts:58` counts `medicaid` as a by-law class in its own right, outside
`planScopeOf`. A wrongly adopted `medicaid` plan therefore *increases* `lawUnits`, and so
`lawLossCents = over × min(lawUnits, units)` at `over-nadac.ts:173`.

It does not break the claim. That figure is rendered on
`src/app/(app)/purchasing/over-nadac/page.tsx:55` — "Paid out as a loss, on fills that pay NADAC by
law" — and goes into no filing; it is the pharmacy telling itself what its own buying cost. And the
evidence rules for `medicaid` are document-borne rather than inferred: a `plan_type` of MEDICAID
(`plan-evidence.ts:135`), a PCN that names Medicaid (`:572`), or a payer name that does (`:606`).
Seven plans and $177.19 were adopted on it.

So: the claim holds. The worst a wrong adoption does is leave money out of a filing. Worth knowing
that `medicaid` is the single class where a wrong adoption moves an internal figure upward, if the
NADAC loss number is ever used for anything beyond that screen.

## Also checked

`caremark-appeal-plan.ts` no longer picks its own claims — it takes them from `worklist`, so the
basis-of-reimbursement gate and the paid-at-NADAC gate now apply to the Caremark form. That is the
right direction, and it is also the whole reason the worklist's own reach matters: see
`docs/audits/2026-09-12-a-floor-on-a-worklist-with-no-screen.md`, where that script turns out to be
the worklist's only consumer outside the tests.
