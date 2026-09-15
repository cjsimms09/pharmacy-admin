# "Send it back" never asks what the supplier will not take back

15 September 2026 · helper B (cloud) · proactive scan, rule 3. Base unchanged since Monday 17:35,
so nothing of session 1's to read. Returns had no audit file and they are named in the owner's
mandate, so that was the area.

---

## The finding

```
OBSERVATION: `ReturnTerms` (supplier-terms.ts:102-124) captures two fields from the supplier's own
             returns policy:

                 nonReturnable        "Categories the supplier will not take back, in the policy's
                                       own words."
                 reverseDistributor   "Who handles it when the supplier does not: a reverse
                                       distributor, by name."

             Both are read out of the contract by the AI reader (ai.ts:942-943), stored, shown on
             the supplier terms page, and counted in a mailbox summary line (mailbox.ts:1115). The
             placeholder the site prints in that textarea is its own suggestion of what belongs
             there — terms/page.tsx:858:

                 placeholder={"refrigerated\ncontrolled Schedule II\npartial bottles"}

             **Neither field is read by either module that decides what goes back.** `grep` over
             `returns-due.ts` (292 lines) and `return-soon.ts` (438 lines) returns nothing for
             `nonReturnable` or `reverseDistributor`, and nothing for `controlled`, `itemClass`,
             `dea` or `schedule` either. `returnsDueNow` loads `db.query.invoiceLines.findMany()`
             (returns-due.ts:246) with no filter, and `invoice_lines` carries both
             `controlled` (schema.ts:935) and `item_class` (:917).

             The output is not advisory. `page.tsx:697-714` — the Today screen, the doorway — raises
             a **red "now"** alert reading *"$X of return credit goes in N days"* whose button says
             **"Send it back"**. The same rows reach `/purchasing/return-soon`,
             `/inventory/returns`, `money-found.ts:367`, `shelf.ts:476`, `lean-shelf.ts` and the
             **email digest** (digest.ts:165,184). The one guard named in that block,
             `warnableReturns`, is about idle drugs — "a fortnight of claims makes a monthly drug
             look dead" — not about what may lawfully be shipped.

SHOULD BE:   A return of a controlled substance is not a credit request; it is a DEA-regulated
             transfer between registrants. A Schedule II cannot move on a packing slip: 21 CFR 1305
             requires a DEA Form 222 or its CSOS equivalent, executed by the *receiving* registrant,
             and stock going for disposal goes to a DEA-registered reverse distributor under
             21 CFR 1317.05, with the record kept. Schedules III–V need a documented transfer record
             even where no 222 is required. That is why wholesalers name controls among the
             categories they will not take back on their ordinary returns process — which is exactly
             what `nonReturnable` holds, and exactly why the policy also names a reverse distributor
             for what it will not take.

             So a worklist that names a physical act — box this and ship it for credit, N days left —
             must state what the supplier's own policy says about that line before naming the act.
             This project's rule for it is already written: *"Nothing is inferred where a document
             could say it."* Here the document does say it, the site has read it, stored it and put
             it on a screen — and the worklist does not ask.

DIFFERENCE:  Yes. The site reads the policy and then ignores it at the one moment it is about to
             cause somebody to move stock. A Schedule II line, or a refrigerated line, or a partial
             bottle, appears on the doorway screen in red with "Send it back" and a countdown, with
             nothing on the row to say the supplier will refuse it — or, for a control, that shipping
             it the ordinary way is a recordkeeping violation rather than a refused credit.
```

### Ranked: **board**, above every money finding on the index

Pre-flight #7 orders patient harm > board > PBM > money. This is board. Not because a credit is lost
— a refused return is only money — but because the act it instructs, performed on a Schedule II
without a 222, is a DEA recordkeeping failure by the registrant whose licence the business runs on.

**The same file already knows this matters.** Forty lines below the return policy table, `schema.ts`
records `includedScheduleTwo` on an *email-forwarding* audit, because *"Forwarding a controlled
substance record to an accountant or a lawyer is a disclosure … the part worth being able to see."*
The site tracks Schedule II when it emails a **record about** a control, and says nothing when it
tells the owner to ship the **control itself**.

### Relation to open row 2

Row 2 is the buy list's controlled gate asking the weakest of three sources. This is the same root
one turn worse: the buy list at least *has* a gate. The return list has none, and unlike the buy list
the answer is not a matter of inference at all — the supplier wrote it down and the site typed it in.

## The fix — session 1's; it is a store and two pages

1. **Ask the policy.** `returnsDueNow` already loads each supplier's return terms to get the credit
   steps; `nonReturnable` arrives in the same object. A line whose description or class matches a
   `nonReturnable` category is not a candidate — it is a **measured-and-none**, shown with the
   supplier's own words beside it, not dropped silently.
2. **Ask the invoice line.** `invoice_lines.controlled` and `item_class` are already captured. Any
   line that is or may be controlled carries a mark on every surface, and the Today alert does not
   say "Send it back" for it.
3. **Say who does take it.** Where the policy names a `reverseDistributor`, the row names them. That
   turns a refusal into an instruction, which is what rule 4 asks of anything incomplete.
4. **Where the class is unknown, say so** rather than defaulting to returnable — *never-measured*, on
   the row.

I have not touched any of it: `returns-due.ts`, `return-soon.ts` and both pages are session 1's.

## Pre-flight

1. **Physical act named** — yes, and it is the point: box stock and ship it to a supplier for credit.
2. Time — now; the alert is a countdown and fires at ≤ `WARN_CREDIT_DAYS`. 3. **What a pharmacist
knows that the tables do not** — that a control leaves the building under 21 CFR 1305/1317 and not on
a returns label; this is the whole SHOULD BE. 4. Whose money — his credit, and his registration.
5. Units — days and cents, not in dispute here. 6. "Same drug" — n/a; this is per invoice line.
7. **Worst case ranked** — board, above the money findings, placed there on the index.
8. **Could the check pass for the wrong reason** — yes, and I nearly let it: I first went looking for
a missing DEA concept and instead found the concept *present and captured*, which is worse and more
precise. 9. When he needs to know — before the next return goes out. 10. Registers — `docs/registers/`
generated, not mine; HANDOFF index updated. 11. **What else reads this figure** — the same rows reach
seven surfaces: two pages, Today, the email digest, `money-found`, `shelf` and `lean-shelf`. None of
them adds a caveat; I checked both pages for any mention of controls, DEA, Schedule II or Form 222
and there is none. 12. **What I did not check** — how many controlled or otherwise non-returnable
lines are on the list today, and whether any supplier's stored `nonReturnable` is actually populated
rather than empty. Both need the pharmacy's database. If every policy on file has an empty
`nonReturnable`, the fix still stands but the exposure today may be nil, and I cannot tell. The
question is in `HANDOFF.md`.
