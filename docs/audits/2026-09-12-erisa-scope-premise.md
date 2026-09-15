# The floor's four scope gates agree — and the reason they exclude self-funded plans is worth checking against *Rutledge*

**Audited:** `4615a7c`'s `commercial_unknown_funding` and the plan-scope gates behind the Kansas
floor, while the base was quiet at `1a8554f`. **By:** the cloud session (B).

No defect. One verification worth recording, and one question that may be worth money.

---

## 1. The safety property holds, across one more gate than the commit claims

`4615a7c` introduces `commercial_unknown_funding` — a class that states the benefit type and
expressly not the funding — and claims it *"is absent from every floor whitelist — `planScopeOf`,
`SCOPE_OF` in floor-review.ts, and `needsBasis`"*. That is three gates. There is a fourth:
`CLASS_INFO[cls].inScope`, read by `against-nadac.ts:155` and `claims.ts:1082`.

Run across every class:

```
class                          inScope   planScopeOf           SCOPE_OF              needsBasis
* commercial_fully_insured     true      commercial_non_erisa  commercial_non_erisa  true
  commercial_self_funded       false     commercial_erisa      commercial_erisa      true
* governmental                 true      commercial_non_erisa  commercial_non_erisa  true
* church_plan                  true      commercial_non_erisa  commercial_non_erisa  true
  medicare                     false     part_d                part_d                false
  medicaid                     false     medicaid              medicaid              false
  workers_comp                 false     unknown               —                     false
  discount_card                false     unknown               —                     false
  copay_card                   false     unknown               —                     false
  commercial_unknown_funding   false     unknown               —                     false
  unknown                      false     unknown               —                     false

* = a class a Kansas floor filing can reach by default
```

The claim holds, and holds on the gate it did not name. Three observations worth keeping:

- **Exactly three classes can reach a floor filing, and all three require a basis.** So no plan can
  be carried into a Kansas filing without a person recording how it was established — `classifyPlan`
  refuses a basis under ten characters with a sentence naming what would count.
- **The four gates never disagree for any class.** Given how often two readers of one field disagree
  in this repository, that is worth stating rather than assuming.
- **`governmental` and `church_plan` in scope is right**, and for a reason stronger than preemption
  analysis: both are excluded from ERISA coverage outright by 29 U.S.C. § 1003(b)(1) and (b)(2), so
  there is no ERISA plan to preempt anything.

---

## 2. The stated reason for excluding self-funded plans is a preemption claim, and *Rutledge* held the opposite

`reimbursement-rules.ts` states the premise twice:

> line 9: *"sets a floor for commercial plans **not preempted by ERISA**"*
> line 144: *"Self-funded ERISA plan — **preempted, the state floor does not reach it**."*

That is a statement about federal preemption, and it is the point *Rutledge v. Pharmaceutical Care
Management Association*, 592 U.S. 80 (2020) decided — **unanimously, the other way**. Arkansas Act
900 required PBMs to reimburse pharmacies at or above their acquisition cost, with an appeal
mechanism. The Court held it **not preempted by ERISA**, expressly including as applied to PBMs
administering **self-funded ERISA plans**: a law regulating what PBMs pay pharmacies is rate
regulation, an area of traditional state authority, and cost effects on a plan are not enough to
"relate to" it.

An acquisition-cost floor with an appeal route is the same species of law as Act 900. So *"self-funded
→ preempted → the floor does not reach it"* is, as a statement of federal preemption law, the
proposition *Rutledge* rejected.

**What I am not saying.** I am not saying the mapping is wrong. A state may write a narrower law than
the Constitution permits, and if **SB 20's own scope provision** limits it to plans not subject to
ERISA, then excluding self-funded plans is correct as a matter of *Kansas* law and the only fault is
that the comment gives a federal reason for a state limit. **I do not have the statute here and will
not assert what its scope provision says.**

**And one case genuinely cuts the other way, in the circuit that matters.** *PCMA v. Mulready*
(10th Cir. 2023) — Kansas is in the Tenth Circuit — found several Oklahoma PBM provisions preempted.
It distinguished them from Act 900 as network-composition and plan-design mandates rather than rate
regulation. A pure reimbursement floor sits on the *Rutledge* side of that line, but the line exists
and a Kansas filing would be argued in that circuit.

**Why it is worth an hour of somebody's time.** Most large employers self-fund. If a substantial
share of this pharmacy's commercial claims is being held out of every floor test on a preemption
premise the Supreme Court rejected, that is money never pursued. **The direction of the error is the
safe one** — the site never claims a floor it should not, so nothing filed today is wrong, and
nothing here should be changed on my say-so. What is wanted is the statute read against the premise.

**For 1, and for the owner:** does SB 20 exclude self-funded plans **by its own terms**, or is
`reimbursement-rules.ts:144`'s reason a preemption assumption? If the statute does not exclude them,
`commercial_self_funded` may belong in scope, and 396 plans' worth of funding questions become worth
settling for a different reason than the register currently gives.

Primary sources, so nobody takes this from me second-hand: *Rutledge v. PCMA*, 592 U.S. 80 (2020);
*PCMA v. Mulready*, 78 F.4th 1183 (10th Cir. 2023); 29 U.S.C. § 1003(b); Kansas SB 20 as enacted.

---

Nothing in `plans.ts`, `plan-evidence.ts`, `floor-review.ts`, `reimbursement-rules.ts`,
`against-nadac.ts` or `claims.ts` was edited by me.
