# Rules for a session working on this repository

There is one session on the pharmacy computer that is **responsible for the site**: it reviews
every change, it merges, and it pushes. Call it the **lead**. Every other session is a **worker**.
If you are reading this and you were not told you are the lead, you are a worker.

A worker's job is to produce work the lead can check quickly and merge without archaeology. These
rules exist to make that possible. They are not style preferences — each one is here because
breaking it has already cost this project a day or a wrong number on a screen.

---

## 1. What you may never do

- **Never push to `feature/compliance`.** That is the branch the pharmacy's site actually runs
  from. Work on your own branch and open a pull request against it. The lead merges.
- **Never commit data.** No PioneerRx reports, invoices, remittances, statements, contracts,
  credentials, database files, or anything with a patient in it. A feed's *shape* goes in
  `fixtures/` with every identifier changed. If you are unsure whether a file is data, it is data.
- **Never delete or rewrite another session's file** without saying so on the pull request first.
  Open branches and the files they touch are listed in `docs/HANDOFF.md`.
- **Never renumber a migration that has already been applied on the pharmacy computer.** Drizzle
  decides what to run by the timestamp in `drizzle/meta/_journal.json`, not the filename. A
  migration that arrives in a merge with an earlier timestamp than one already applied is silently
  never run — no error, just a missing table and a 500 the first time somebody opens the page. If
  your number collides, renumber **yours** and give it a later `when`.
- **Never invent a number.** If a figure cannot be derived from a document or a query, the screen
  says it is not known. A confident wrong number is the worst thing this site can produce.

## 2. Where the truth lives

Read these before starting, not after:

| File | What it settles |
| --- | --- |
| `CLAUDE.md` | How the two-machine setup works, and the rules that hold on both sides |
| `docs/BACKLOG.md` | Everything the owner has asked for, in his words. The queue |
| `docs/HANDOFF.md` | What each session has done and what it needs from the other |
| `docs/reference/data-dictionary.md` | Every figure: one meaning, one unit, what it must never be used for |
| `docs/reference/buying-logic.md` | Why the purchasing arithmetic is what it is |
| `docs/reference/profit-engine.md` | How profit is computed |
| `docs/reference/design-audit.md` | The site's design rules and page inventory |
| `docs/reference/contract-reading.md` | What is read from a contract, why, and where it goes |

## 3. Which session can see what

**Only a session running on the pharmacy computer can see real data.** A cloud session's network
reaches GitHub and a few package registries and nothing else — this was established by measurement
after a tunnel had already been built and opened, and it could never have worked. Thirteen hosts
were tested; `github.com`, `api.github.com` and `raw.githubusercontent.com` answer, and every
tunnelling service refuses.

So if you are in the cloud: **do not propose a tunnel, a hosted copy, or asking the owner to email
you a file.** Any question that needs the real database, the real screens or the real files is
written into `docs/HANDOFF.md` for the machine session to answer. That is the whole mechanism.

If you are on the pharmacy computer, you can read the database — and you are then the only one who
can, so answering those questions is part of your job, not an interruption.

## 4. How to be right about money

This is the part that matters most, and it is where this project has already been wrong.

- **Nothing is inferred where a document could say it.** Read the invoice, the contract, the file.
  Deriving a figure that the paperwork states is how you get a plausible number that is wrong.
- **Every reader that decides money is checked by arithmetic before anything is stored.** Unit cost
  times pack quantity must equal pack cost. A total must equal the sum of its lines. Where it does
  not, the row is quarantined and says so — it is not silently corrected.
- **Units are part of the number.** A per-EA cost compared against a per-ML benchmark produced
  "100× the national average" on real rows here. EA, ML and GM never mix. Micros are millionths of
  a dollar; cents are cents; thousandths are quantity. The suffix on the field name is binding.
- **Grouping two drugs that are not the same drug is a dispensing error waiting to happen.**
  Failing to group two that are is a missed saving. When in doubt, split — the asymmetry is not
  symmetric and the safe direction is always "more groups".
- **Measure before you change, and measure after.** "This should be better" is not a result. On
  this database, on real rows, how many changed and by how much? Put the number in the commit
  message. Every claim in this repository's history has one behind it.

## 5. How to write code here

- Match the file you are editing: its comment density, its naming, its idiom. This codebase
  explains *why* in prose above the code, in full sentences, and names the failure that motivated
  it. A change that arrives with no explanation reads as an accident.
- **Pure functions where the arithmetic lives, stores for the reading.** `foo.ts` is pure and
  tested; `foo-store.ts` reads the database and calls it. Do not put a query in a pure module.
- **Tests are the argument, not the ceremony.** Test the case that was actually wrong, and name the
  test after what it protects — `"the form the description lost is still kept apart"`, not
  `"test groupKey 3"`.
- **Every libsql call blocks the Node event loop completely.** 200,000 rows read is 1.7 seconds
  during which the web server answers nothing at all. Anything long-running belongs in a separate
  process — `scripts/make-claude-copy.ts` is the worked example.
- **Migrations are additive and numbered.** Add columns, do not repurpose them. See rule 1.

## 6. Before you hand anything back

Run this, and do not hand back work that fails it:

```
npm run db:migrate     # tests that touch the database need a migrated one
npm run check          # typecheck, tests, build
```

Four tests fail on `feature/compliance` today and are **not yours**: `temp-signoff` (a reading
filed under the wrong calendar month), `backup-destinations` (two relative-path cases) and one
fixtures test. If those four are the only failures, you are clean. If there is a fifth, it is
yours.

## 7. What to hand back

Open a pull request against `feature/compliance` and put in the description:

1. **What was wrong**, in plain sentences, with the number that shows it.
2. **What you changed**, and what you deliberately did not.
3. **What you measured after**, on real data where you could reach it, and where you could not,
   say so explicitly rather than implying you did.
4. **Anything you touched that another session owns**, named.
5. **What you are unsure about.** An honest "I could not verify this" is worth more than a
   confident guess, and the lead can check it on the machine that has the data.

Then add a line to `docs/HANDOFF.md` under "Open items". **Anything either side wants the other to
see goes in the repository, never only in a conversation** — the sessions cannot read each other's
chats, and the owner should not have to relay.

## 8. Who the owner is, and what he wants

He is the pharmacist-in-charge and the owner. He is not a programmer. He runs the business on this
site. His standing instructions:

> "Everything we do, we need to consider the end goal which is finding way to make pharmacy more
> money — if it doesn't lead to that then what we are doing is pointless."

> "Take the request I give you and act as me, give me what I want and the best tool, not
> necessarily exactly what I ask for."

> "Double check all logic to make sure it makes sense — ordering logic, NADAC, pricing, which
> supplier to buy from."

Give him findings in plain sentences with the money attached, not a list of function names. If the
best tool is not the thing he literally asked for, build the best tool and say why in one sentence.
