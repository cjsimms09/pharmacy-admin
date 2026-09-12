# pharmacy-admin

## The gate. Nothing reaches the owner without passing it.

He audited the working agreement on 12 September 2026 and his verdict was that the principles were
right and **not procedurally unavoidable**: *"The remaining work is making them procedurally
unavoidable so the agent carries the completeness load instead of you."* So they live here, in the
file every session loads, rather than in a document a session might not open.

**1. No finding is reported until it is written in three lines.** In this order, and the middle one
is the gate:

```
OBSERVATION: exactly what the system shows, with numbers
SHOULD BE:   what ought to be true, and why — from pharmacy practice, accounting, or how he runs
             the business. NOT from the data that produced the observation.
DIFFERENCE:  only if they differ. If they do not, this is not a finding.
```

**If the SHOULD BE line cannot be written from domain knowledge, there is no finding — there is one
precise question, and it goes to him as a question.** This rule exists because a finding that the
delivery driver "works for nothing on a cash basis" was reported twice, and both times it
contradicted accounting already understood. He caught it, which is the failure.

**2. Pre-flight, on anything a person might act on.** Confirm it was run, in one line, in the
report. Any answer of "not checked" is said out loud rather than skipped.

1. Physical act named? 2. Time dimension — this month, next three, next eleven? 3. What a pharmacist
knows that the tables do not? 4. Whose money, which basis, which period, already counted elsewhere?
5. Units verified — pack size, strength, days supply? 6. "Same drug" disambiguated *for this
purpose*? 7. Worst case ranked — patient harm > board > PBM relationship > money? 8. Could the check
pass for the wrong reason? 9. When does he need to know, and is that when it appears? 10. Registers
updated? 11. **What else reads this figure** — the costliest faults have been two correct things
meeting. 12. **What did I not check, and have I said so?**

**3. Proactive scan, every session, unprompted.** Scan the open findings register and the four
channels for a dollar that can fall between them; look at the newest import, remits and expenses for
anomalies; re-run the three-line test on every open finding; ask *what would he be most angry about
if it were wrong and I had not caught it*; and report at least one concrete observation **or one
area confirmed clean**.

**4. Nothing ships without the means to correct it.** On the same screen: the source of every
number, a one-press "this is wrong / this is settled / override", an override that survives the next
import, and an explicit state for anything incomplete — *not yet arrived*, *never measured*,
*awaiting your decision*. A tool is not the calculation; the calculation is the easy half.

**5. Four states, never one word.** Captured · expected-not-yet · never-measured · measured-and-none
· not-captured. "Missing" is not a state and must never be reported as one.

Full reasoning and the failures that earned each clause: `docs/CONSTITUTION.md`. The questions in
long form and what they found: `docs/FOUNDATIONS.md`. The registers, generated from the data by
`scripts/registers.ts` so they cannot rot: `docs/registers/`. Open findings with money and owner:
`docs/OPEN-ITEMS.md`.

---

The admin desk of one independent pharmacy in Kansas. The owner runs the business on it. Two
Claude sessions build it, on two accounts, and they cannot see each other's conversations:

- the **pharmacy session** works on `feature/compliance`, the branch the site runs from;
- the **cloud session** works on `claude/repo-audit-catalog-claims-*` branches and opens a pull
  request against `feature/compliance` for each piece of work.

**Only a session running on the pharmacy computer can see real data.** A cloud session's network
reaches GitHub and a few package registries and nothing else — no tunnel, no address, no hosted
copy of this site is reachable from one, and that was established by measurement after a tunnel had
already been built and opened. So any question that needs the real database, the real screens or
the real files belongs to the machine session, and the cloud session must hand it over through
`docs/HANDOFF.md` rather than asking the owner to ferry files. Start Claude on that computer by
double-clicking **Work on this with Claude.cmd**.

**At the start of every session, read `docs/HANDOFF.md`, top section "Open items", and the open
pull request from the other session.** That is the whole handshake. Anything either side wants
the other to see goes in one of those two places, never only in a conversation.

Rules that hold on both sides:

- **Code only. Never data.** No PioneerRx reports, invoices, remittances, statements, contracts,
  credentials or database files in git. A feed's *shape* goes in `fixtures/` with every
  identifier changed (`fixtures/README.md`). No patient information anywhere.
- **Nothing is inferred where a document could say it**, and every reader that decides money is
  checked by arithmetic before anything is stored. Every figure has one meaning, one unit and a
  list of what it must never be used for: `docs/reference/data-dictionary.md`. The reasoning is
  in `docs/reference/buying-logic.md`, `data-audit.md` and `profit-engine.md`; the site's design
  rules and page inventory are in `docs/reference/design-audit.md`; what is read from a contract,
  why, and where it goes is `docs/reference/contract-reading.md`.
- Migrations are additive and numbered; the second session to merge renumbers its own.
- Files the other session has changed on an open branch are listed in `docs/HANDOFF.md`; say so
  on the pull request before editing one.
- `npm run check` (typecheck, tests, build) before pushing. Tests that touch the database need a
  migrated one: `npm run db:migrate` first.
