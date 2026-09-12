# Sixteen modules, 3,829 lines, fourteen of them tested, and nothing imports any of them

*12 September 2026 — session 2 (cloud). A sweep of all 294 modules in `src/lib`, checked against
every import in `src/` and `scripts/`. **No file of session 1's is edited.** This is the largest thing
I have found on this repository.*

## What was measured

For each of the 294 modules in `src/lib`, every `.ts` and `.tsx` file in `src/` and `scripts/` was
searched for an import path ending in that module's name. Sixteen have none. There is no dynamic
escape hatch: `grep` for a template-literal or variable module path across the whole of `src/`
returns nothing, so every import in this codebase is a literal string, and a module no literal names
cannot be reached.

Each was then re-checked by plain text search for the module's name anywhere outside its own file.
Fifteen have zero mentions. The sixteenth, `ndc-choice.ts`, has one — a sentence in a comment in
`under-nadac.ts` saying what it would do.

```
 lines  tests  added        module
   428   no    2026-09-08   psao-guide.ts
   403   yes   2026-09-11   claim-reconcile.ts
   358   yes   2026-09-06   month-plan.ts
   314   yes   2026-09-05   gs1.ts
   266   yes   2026-09-06   price-moves.ts
   263   yes   2026-09-10   remit-classify.ts
   257   yes   2026-09-08   bank-reconcile.ts
   228   yes   2026-09-11   providerpay-account.ts
   211   no    2026-09-11   supplier-statement.ts
   185   yes   2026-09-06   band-strategy.ts
   179   yes   2026-09-05   ndc-choice.ts
   175   yes   2026-09-10   month-stability.ts
   152   yes   2026-09-06   reimbursement-fit.ts
   149   yes   2026-09-10   route-agreement.ts
   144   yes   2026-09-08   pbm-listing.ts
   117   yes   2026-09-09   reversed-fill-payments.ts
```

Every one was added between 5 and 11 September and **not one has been touched since the commit that
added it**. Four were added in the last two days. This is not work in progress from an hour ago.

## What they are

Their own first lines:

| module | what it says it is |
|---|---|
| `claim-reconcile` | *"Whether a claim is settled, and where every dollar of it went."* |
| `providerpay-account` | *"The ProviderPay sweep account, **which is the only thing that ties a payment to the bank**."* |
| `supplier-statement` | *"A wholesaler's statement of account: which invoices are about to be taken, and when."* |
| `bank-reconcile` | *"What a deposit is made of."* |
| `remit-classify` | *"Where an adjustment on a remittance belongs in the books."* |
| `reversed-fill-payments` | *"Money a plan paid for a fill the pharmacy reversed, and whether the plan has taken it back yet."* |
| `month-stability` | *"A month that has been reported should not quietly become a different month."* |
| `route-agreement` | *"The same question, asked two ways, must give the same answer."* |
| `month-plan` | *"The month's purchasing, decided with every variable at once."* |
| `band-strategy` | *"The McKesson question, answered by arithmetic."* |
| `ndc-choice` | *"Which NDC of a product to buy: the one that pays the most, not the one that costs the least."* |
| `price-moves` | *"What changed this week in what the pharmacy pays and what it is paid."* |
| `reimbursement-fit` | *"Back-calculating how a plan prices a claim, from the claims it has paid."* |
| `psao-guide` | the crosswalk from the network id a claim carries to the network a rate is for |
| `pbm-listing` | *"The PSAO's contracted PBM listing, read into the BIN register."* |
| `gs1` | *"Reading the 2D barcode on a drug package."* |

That is not a pile of helpers. It is the money trace (claim → 835 → sweep account → bank), the
purchasing decision, the reconciliation checks, and two documents the owner uploaded himself.

## Three things make this worse than dead code

**One — the commit subjects are in the present indicative.**

- `98c69d9`: *"The PSAO's contracted PBM listing **reads into** the BIN register."* `loadPbmListing`
  is called by nothing, so nothing reads into the register. That listing is the document that would
  replace BIN rows currently reading *"named by Cory Simms from a claim"*.
- `1813274`: *"The PSAO's networks guide **is read into** the library, and the network ids it prints
  link on their own."* `loadPsaoGuide` is called by nothing. Its own docstring: *"It closes the gap
  no contract closed"* — the crosswalk from NCPDP 545-2F to a named network. The owner uploaded it on
  8 September: *"here we go!!"*

**Two — two of them are the named sources for `books-check.ts`'s own double-count register.**
`countedTwice` lists eleven routes by which money could be counted twice, and names for two of them:

> *"What was paid to the wholesalers — **The wholesaler's own ledger, what cleared and under which ACH**"* → `supplier-statement.ts`
> *"The PSAO's payments — **The ProviderPay payment report, itemised by payer and payment number**"* → `providerpay-account.ts`

The register the owner asked for names, as one of the two records that know a figure, a reader with
no way in.

**Three — `supplier-statement.ts` has a table waiting for it.** `src/db/schema.ts:3480` documents a
table by naming the file: *"`supplier-statement.ts`. What these rows carry is the two facts an
invoice does not…"*. Schema, reader, and no path from a document to either. Its own docstring says
why it matters: *"Every invoice sharing a due date is taken as ONE debit, which is why a bank line
never matches an invoice and why matching by amount has been impossible. **The statement is the
missing key.**"*

## What this is, and what it is not

It is **not** a claim that any figure on the site is wrong. Nothing unreachable can compute a wrong
number. Fourteen of the sixteen have test files, and those tests pass — which is exactly why this
does not show up as a failure anywhere: a well-tested module with no caller is green.

It **is** the repository's own stated fault at its largest scale. `DAILY-CHECK.md` puts it as *a
check that lands nowhere is not a check*, and session 1 has fixed that shape twice in the last week —
`stillStranded` in `693114d`, and `looksLikeInvoiceFromUnknownSender` before it. This is the same
fault sixteen times over, and it means the owner is looking at a site that does not know what a
deposit is made of, cannot trace a payment to the bank, and has not read two documents he uploaded
four days ago and was pleased about.

## For session 1

Nothing here needs the real database. What it needs is a decision, per module, and it is yours:

1. **Wire it** — the module works and its page or job was never built.
2. **Say it is a specification** — a note at the top, so the next reader does not take it for live.
3. **Delete it** — it was superseded and nobody said so.

What it must not stay is the fourth thing: present-tense commit subjects, passing tests, and no way
in. If it would help, I will do the mechanical part of any of the three on this branch — but which of
the three each module gets is a judgement about what the pharmacy needs, and that is the side of the
handoff with the data on it.

---

## Addendum: what each would take, so the decision is a costed one

Measured, not guessed: whether the module touches the database, what it writes, and whether it
carries its own `looksLike…` recogniser (which is how the intake router dispatches a document).

**Already complete — needs only a caller.** The write is written and the table exists:

| module | writes to | missing |
|---|---|---|
| `pbm-listing` | `payerBins` (`:119`, `:136`) | one caller — an intake case or a button |
| `psao-guide` | `contractDocs`, `contractText` (`:401-420`) | one caller |
| `reversed-fill-payments` | reads only; `paymentsOnReversedFills()` and `reversedFillMoney()` take no arguments and return render-ready rows | one page, or one tile on Claims |

`reversed-fill-payments` is the cheapest thing on this list and answers a question the owner asked on
9 September in the module's own opening quote. Two argument-free functions, one of which already
returns `{ fills, heldCents, over30, over30Cents }` — the exact shape of a KPI tile.

**Built to be dispatched to, and the router never got the case.** Each carries its own recogniser:

| module | recogniser | what the router would do with it |
|---|---|---|
| `supplier-statement` | `looksLikeStatement(text, fileName)` `:206` | read it, store the due dates in the table `schema.ts:3480` already documents |
| `providerpay-account` | `looksLikeAccountHistory(text)` `:105` | read it, so a sweep line on the bank statement resolves into payers |

Both are pure — text in, rows out — so neither can have been half-wired by accident. The intake path
has a `kind` for the McKesson AP report (`ap_transactions`, added in the same commit as
`supplier-statement`) and none for either of these.

**Pure, and needing a store as well as a page:** `claim-reconcile`, `month-plan`, `gs1`,
`price-moves`, `remit-classify`, `bank-reconcile`, `band-strategy`, `ndc-choice`, `month-stability`,
`reimbursement-fit`, `route-agreement`. These are the expensive ones, and the ones where "mark it a
specification" may well be the right answer for now.

That is the whole shape of the decision: three that need a caller, two that need an intake case, and
eleven that need a feature. None of it is mine to choose.
